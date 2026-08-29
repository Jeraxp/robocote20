/**
 * O MOTOR DA CONVERSA — Fase 3 da unificação.
 *
 * Esta função não sabe o que é WhatsApp. Recebe quem falou, o que disse e um
 * jeito de responder (`deps.send`); devolve o que foi respondido e o novo estado.
 * O canal vira um adaptador fino nas pontas — é o que vai permitir o webchat
 * reusar a mesma jornada, os mesmos guard-rails e os mesmos detectores (Fase 4).
 *
 * REGRA DURA: nada aqui pode importar de `channels/`. Se importar, a extração
 * falhou e voltamos a ter dois produtos com o mesmo nome.
 */

import { handleAutoF1AssistantMessage, type AssistantAction } from '../../assistant/autoF1.js';
import { runAutoF1Quote, type AutoF1QuoteRequest } from '../../journey/autoF1.js';
import { loadCatalogForStep } from '../../catalog/auto.js';
import { decodePlate, pickPlateDecodeOutcome, isValidPlateFormat, normalizePlate } from '../../segfy/placa.js';
import { buscarCondutor } from '../../segfy/condutor.js';
import {
  sessionStore,
  createInitialSessionState,
  appendSessionInteraction,
  type SessionState,
  type SessionKey,
  type SessionChannel,
} from '../../session/store.js';
import { getAgentName } from '../../tenant/agent.js';
import { cacheQuoteContext } from '../../quote/contextCache.js';
import { getTenantActiveRamos, isVehicleRamo, VEHICLE_RAMOS, type VehicleRamo } from '../../tenant/quoteConfig.js';
import {
  SERVICE_TYPE_QUESTION,
  buildGreeting,
  parseServiceType,
  buildBranchQuestion,
  parseBranchChoice,
  maskCpfPii,
  isCalcConfirmation,
  looksLikeConfirmation,
  looksLikeDenial,
  looksLikeFullName,
  isResetIntent,
  buildRecapMessage,
  looksLikeNoPlateSkip,
  extractPlateFromMessage,
  extractValidCpf,
  maskCpf,
} from './language.js';
import {
  RAMO_LABELS,
  STEP_PROMPT,
  nextStepAfter,
  applyProposalAndAdvance,
  setBranchAndStartJourney,
  type StepId,
} from './steps.js';

/** Mensagem que chega, já sem nada de canal: quem falou, o que disse, de quem é. */
export interface CoreInbound {
  tenantId: string;
  channel: SessionChannel;
  /** Identificador do lead DENTRO do canal (telefone no WhatsApp, id no webchat). */
  userId: string;
  text: string;
  timestamp: string;
  /** Detector: a corretora não foi identificada pela origem (ver Fase 2). */
  tenantUnresolved?: boolean;
}

/** O que o canal precisa fornecer ao motor. Hoje só uma coisa: como responder. */
export interface TurnDeps {
  send(text: string): Promise<unknown>;
}

export type TurnAction =
  | AssistantAction
  | 'greet' | 'calc_failed' | 'reset'
  | 'human_intervention' | 'human_paused' | 'human_handoff_back' | 'human_handoff_requested'
  | 'service_type' | 'branch_selected';

export interface TurnResult {
  replySent: string | null;
  action: TurnAction;
  sessionAfter: SessionState | null;
}

const CALCULATE_IDEMPOTENCY_MS = 60_000;

/** Tempo máximo sem mensagem outbound do humano antes do bot retomar automaticamente. */
const HUMAN_OVERRIDE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

const PROGRESS_NUDGE_MS = 15_000;

const ROBOCOTE_QUOTE_BASE_URL = process.env.ROBOCOTE_QUOTE_BASE_URL?.trim() ?? '';

/** Ramos vehicle que a corretora oferece (ramos ativos ∩ suportados). Fallback ['auto']. */
async function resolveOfferableRamos(tenantId: string): Promise<VehicleRamo[]> {
  try {
    const active = await getTenantActiveRamos(tenantId);
    const offerable = active.filter((r): r is VehicleRamo => isVehicleRamo(r));
    // Mantém ordem canônica (auto, moto, caminhao) pro menu ficar estável.
    const ordered = VEHICLE_RAMOS.filter((r) => offerable.includes(r));
    return ordered.length > 0 ? ordered : ['auto'];
  } catch {
    return ['auto'];
  }
}

function buildQuoteLink(guid: string): string {
  if (!ROBOCOTE_QUOTE_BASE_URL) return `/quote-room/${guid}`;
  return `${ROBOCOTE_QUOTE_BASE_URL.replace(/\/$/, '')}/quote-room/${guid}`;
}

function recordInbound(
  session: SessionState,
  inbound: CoreInbound,
  action: string,
): SessionState {
  return appendSessionInteraction(session, {
    direction: 'inbound',
    text: maskCpfPii(inbound.text),
    action,
    stepId: session.stepId,
    quoteGuid: session.lastGuid,
  });
}

function recordOutbound(
  session: SessionState,
  text: string,
  action: string,
  quoteGuid: string | null = session.lastGuid,
): SessionState {
  return appendSessionInteraction(session, {
    direction: 'outbound',
    text: maskCpfPii(text),
    action,
    stepId: session.stepId,
    quoteGuid,
  });
}

function recordTurn(
  session: SessionState,
  inbound: CoreInbound,
  reply: string,
  action: string,
  quoteGuid: string | null = session.lastGuid,
): SessionState {
  return recordOutbound(recordInbound(session, inbound, action), reply, action, quoteGuid);
}

function answersFromSession(session: SessionState): AutoF1QuoteRequest['answers'] {
  const a = session.answers;
  const get = (key: string): string => a[key]?.value ?? '';
  const getRaw = (key: string): string => a[key]?.rawValue ?? a[key]?.value ?? '';
  const meta = (a.vehicle_model?.metadata ?? {}) as {
    fipe_code?: string;
    fipe_value?: number | null;
    model_id?: string;
    fuel_type?: string;
  };
  const brandMeta = (a.vehicle_brand?.metadata ?? {}) as { brand_text?: string };

  return {
    name: get('name'),
    mode: 'real',
    insurance_branch: getRaw('insurance_branch') || 'auto',
    vehicle_brand: getRaw('vehicle_brand'),
    vehicle_brand_text: brandMeta.brand_text ?? a.vehicle_brand?.value ?? '',
    vehicle_year: getRaw('vehicle_year'),
    vehicle_model: getRaw('vehicle_model'),
    vehicle_model_text: a.vehicle_model?.value ?? '',
    vehicle_model_id: meta.model_id ?? '',
    vehicle_fipe_code: meta.fipe_code ?? '',
    vehicle_fipe_value: meta.fipe_value != null ? String(meta.fipe_value) : '',
    vehicle_fuel_type: meta.fuel_type ?? '',
    usage: getRaw('usage'),
    renewal_status: getRaw('renewal_status'),
    renewal_bonus: getRaw('renewal_bonus'),
    zip_code: getRaw('zip_code'),
    residence_type: getRaw('residence_type'),
    residence_garage: getRaw('residence_garage'),
    marital_status: getRaw('marital_status'),
    coverage: getRaw('coverage'),
    contact: getRaw('contact'),
    driver_birth_date: getRaw('driver_birth_date'),
    driver_sex: getRaw('driver_sex'),
    document: getRaw('document'),
    // Questionário de risco — respostas reais do segurado
    is_main_driver: getRaw('is_main_driver') || 'yes',
    main_driver_document: getRaw('main_driver_document'),
    main_driver_name: getRaw('main_driver_name'),
    main_driver_birth_date: getRaw('main_driver_birth_date'),
    main_driver_sex: getRaw('main_driver_sex'),
    young_driver: getRaw('young_driver') || 'no',
    studies: getRaw('studies') || 'no',
    study_garage: getRaw('study_garage') || 'no',
    work_commute: getRaw('work_commute') || 'no',
    work_garage: getRaw('work_garage') || 'no',
    monthly_km: getRaw('monthly_km') || '1000',
  };
}

async function triggerCalculate(
  inbound: CoreInbound,
  session: SessionState,
): Promise<{ guid: string; link: string; topReply: string } | null> {
  try {
    const request: AutoF1QuoteRequest = { answers: answersFromSession(session) };
    const result = await runAutoF1Quote(request, 45000, session.tenantId);
    // Registra contexto da cotação (tenantId + customer) pro Quote Room resolver agent_name dinâmico.
    cacheQuoteContext(
      result.guid,
      {
        firstName: session.customerFirstName,
        coveragePreference: session.coveragePreference,
      },
      session.tenantId,
    );
    const link = buildQuoteLink(result.guid);
    const top = result.quoteSummary.options
      .filter((o) => o.category === 'principal')
      .slice(0, 3)
      .map((o, i) => `${i + 1}) ${o.productName} — R$ ${o.annualPremium.toLocaleString('pt-BR')}`)
      .join('\n');
    const topReply = top
      ? `Cotação pronta ✅\n\n${top}\n\nDetalhes completos: ${link}`
      : `Cotação pronta ✅ — detalhes: ${link}`;
    return { guid: result.guid, link, topReply };
  } catch (e) {
    console.warn(`Falha ao calcular cotação WhatsApp: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Roda UM turno de conversa. Sem canal, sem HTTP, sem envio direto — quem envia
 * é `deps.send`, fornecido por quem chamou.
 */
export async function runConversationTurn(
  inbound: CoreInbound,
  deps: TurnDeps,
): Promise<TurnResult> {
  const tenantId = inbound.tenantId;
  const key: SessionKey = { tenantId, channel: inbound.channel, channelUserId: inbound.userId };

  let session = await sessionStore.get(key);
  const isNew = !session;
  if (!session) {
    session = await sessionStore.upsert(createInitialSessionState(key));
  }

  // Detector: a sessão carrega a marca de que a corretora não foi identificada.
  if (Boolean(inbound.tenantUnresolved) !== Boolean(session.tenantUnresolved)) {
    session = { ...session, tenantUnresolved: Boolean(inbound.tenantUnresolved) };
  }

  // ─── Guarda de humanOverride: lead manda mensagem com operador ativo ─────────
  if (session.humanOverride?.active) {
    const idleMs = Date.now() - session.humanOverride.lastActivityAt;
    if (idleMs < HUMAN_OVERRIDE_TIMEOUT_MS) {
      // Pausado — só registra a mensagem, não processa nem responde.
      const persisted = await sessionStore.upsert(
        appendSessionInteraction(session, {
          direction: 'inbound',
          text: inbound.text,
          action: 'human_paused',
        }),
      );
      return { replySent: null, action: 'human_paused', sessionAfter: persisted };
    }
    // Timeout vencido (24h sem outbound humano): bot retoma com recapitulação.
    // Não processa o conteúdo da mensagem atual — só manda o recap e espera a próxima.
    const agentName = await getAgentName(tenantId);
    // Se o humano assumiu ainda no intake, retomar com a cotação não faz sentido —
    // reapresenta o menu de serviço em vez do recap de cotação.
    let recap: string;
    if (session.stepId === 'service_type' || session.stepId === 'branch_select') {
      recap = `${agentName} por aqui de novo. ${SERVICE_TYPE_QUESTION}`;
    } else {
      const currentStep = session.stepId === 'complete' ? 'quote_link' : session.stepId;
      const stepPrompt = STEP_PROMPT[currentStep as StepId] ?? 'Pode continuar de onde paramos?';
      recap = buildRecapMessage(session, agentName, stepPrompt);
    }
    await deps.send(recap);
    const resumedAtIntake = session.stepId === 'service_type' || session.stepId === 'branch_select';
    const cleared: SessionState = {
      ...session,
      humanOverride: null,
      stepId: resumedAtIntake ? 'service_type' : session.stepId,
    };
    const persisted = await sessionStore.upsert(
      appendSessionInteraction(
        appendSessionInteraction(cleared, {
          direction: 'inbound',
          text: inbound.text,
          action: 'human_handoff_back',
        }),
        {
          direction: 'outbound',
          text: recap,
          action: 'human_handoff_back',
        },
      ),
    );
    return { replySent: recap, action: 'human_handoff_back', sessionAfter: persisted };
  }

  // Primeira mensagem: envia saudação e fica aguardando o nome.
  if (isNew) {
    const agentName = await getAgentName(tenantId);
    const greeting = buildGreeting(agentName).join('\n\n');
    await deps.send(greeting);
    const persisted = await sessionStore.upsert(recordTurn(session, inbound, greeting, 'greet'));
    return { replySent: greeting, action: 'greet', sessionAfter: persisted };
  }

  // Reset por palavra-chave — funciona em qualquer ponto. Após cotação concluída
  // também aceita "outra cotação"/"novo carro" pra evitar lead preso no "complete".
  if (isResetIntent(inbound.text, session.completed)) {
    const fresh = createInitialSessionState(key);
    const ack = session.completed
      ? 'Beleza, vamos pra uma nova cotação então.'
      : 'Tudo bem, vamos começar do zero.';
    const agentName = await getAgentName(tenantId);
    const greeting = `${ack}\n\n${buildGreeting(agentName).slice(1).join('\n\n')}`;
    await deps.send(greeting);
    const persisted = await sessionStore.upsert(recordTurn(fresh, inbound, greeting, 'reset'));
    return { replySent: greeting, action: 'reset', sessionAfter: persisted };
  }

  if (session.completed) {
    // Pós-cotação ainda não tem fluxo dedicado. Resposta gentil temporária.
    const reply = 'Sua cotação tá pronta acima. Em breve eu vou poder te explicar as opções por aqui também — por enquanto, dá uma olhada no link que mandei.\n\nSe quiser fazer outra cotação, é só dizer "nova cotação" que eu recomeço.';
    await deps.send(reply);
    const persisted = await sessionStore.upsert(recordTurn(session, inbound, reply, 'none'));
    return { replySent: reply, action: 'none', sessionAfter: persisted };
  }

  // ─── Intake P1 — serviço: cotação ou atendimento humano? (Jera 2026-05-31) ────
  if (session.stepId === 'service_type') {
    const intent = parseServiceType(inbound.text);

    if (intent === 'atendimento') {
      // Handoff humano — reutiliza o mecanismo de humanOverride (pausa o bot).
      const reply = 'Perfeito! Vou chamar um atendente da nossa equipe pra te ajudar por aqui. Já já alguém responde. 🙋';
      await deps.send(reply);
      const now = Date.now();
      const handoff: SessionState = {
        ...session,
        humanOverride: { active: true, startedAt: now, lastActivityAt: now, source: 'lead_requested' },
      };
      const persisted = await sessionStore.upsert(recordTurn(handoff, inbound, reply, 'human_handoff_requested'));
      return { replySent: reply, action: 'human_handoff_requested', sessionAfter: persisted };
    }

    if (intent === 'cotacao') {
      const ramos = await resolveOfferableRamos(tenantId);
      // Um único ramo ativo → pula a pergunta 2 (menos fricção) e já começa a jornada.
      if (ramos.length <= 1) {
        const ramo = ramos[0] ?? 'auto';
        const advanced = setBranchAndStartJourney(session, ramo);
        const reply = `Ótimo, ${RAMO_LABELS[ramo].toLowerCase()} então!\n\n${STEP_PROMPT.name}`;
        await deps.send(reply);
        const persisted = await sessionStore.upsert(recordTurn(advanced, inbound, reply, 'branch_selected'));
        return { replySent: reply, action: 'branch_selected', sessionAfter: persisted };
      }
      const question = buildBranchQuestion(ramos);
      const moved: SessionState = { ...session, stepId: 'branch_select' };
      await deps.send(question);
      const persisted = await sessionStore.upsert(recordTurn(moved, inbound, question, 'service_type'));
      return { replySent: question, action: 'service_type', sessionAfter: persisted };
    }

    // Ambíguo — reapresenta a pergunta 1.
    const reply = `Só pra eu te direcionar certo:\n\n${SERVICE_TYPE_QUESTION}`;
    await deps.send(reply);
    const persisted = await sessionStore.upsert(recordTurn(session, inbound, reply, 'ask_clarification'));
    return { replySent: reply, action: 'ask_clarification', sessionAfter: persisted };
  }

  // ─── Intake P2 — ramo: para qual seguro é a cotação? ──────────────────────────
  if (session.stepId === 'branch_select') {
    const ramos = await resolveOfferableRamos(tenantId);
    const chosen = parseBranchChoice(inbound.text, ramos);
    if (!chosen) {
      const reply = `Não peguei qual seguro você quer. ${buildBranchQuestion(ramos)}`;
      await deps.send(reply);
      const persisted = await sessionStore.upsert(recordTurn(session, inbound, reply, 'ask_clarification'));
      return { replySent: reply, action: 'ask_clarification', sessionAfter: persisted };
    }
    const advanced = setBranchAndStartJourney(session, chosen);
    const reply = `Ótimo, ${RAMO_LABELS[chosen].toLowerCase()} então!\n\n${STEP_PROMPT.name}`;
    await deps.send(reply);
    const persisted = await sessionStore.upsert(recordTurn(advanced, inbound, reply, 'branch_selected'));
    return { replySent: reply, action: 'branch_selected', sessionAfter: persisted };
  }

  // ─── P1 — Proposta pendente aguardando confirmação ──────────────────────────────
  // Quando a Robocotepropôs algo usando pista anterior e marcou pendingConfirmation,
  // a próxima mensagem do lead pode ser "sim/não". Interceptamos antes do handler
  // pra evitar que "sim" vire resposta do próximo step.
  if (session.pendingProposal) {
    const pending = session.pendingProposal;

    if (looksLikeConfirmation(inbound.text)) {
      const advanced = applyProposalAndAdvance(session, pending);
      const next = advanced.stepId;
      const ack = `Anotei: ${pending.displayLabel ?? pending.value}.`;
      const followUp = next !== 'complete' && STEP_PROMPT[next as StepId]
        ? `\n\n${STEP_PROMPT[next as StepId]}`
        : '';
      const reply = `${ack}${followUp}`;
      await deps.send(reply);
      const persisted = await sessionStore.upsert(recordTurn(advanced, inbound, reply, 'answer_step'));
      return { replySent: reply, action: 'answer_step', sessionAfter: persisted };
    }

    if (looksLikeDenial(inbound.text)) {
      const currentStep = session.stepId === 'complete' ? 'quote_link' : session.stepId;
      const prompt = STEP_PROMPT[currentStep as StepId] ?? 'Me passa o dado de novo, por favor.';
      const reply = `Beleza, vou refazer. ${prompt}`;
      await deps.send(reply);
      const cleared = await sessionStore.upsert(recordTurn({ ...session, pendingProposal: null }, inbound, reply, 'ask_clarification'));
      return { replySent: reply, action: 'ask_clarification', sessionAfter: cleared };
    }

    // Mensagem ambígua: limpa proposta pendente e segue fluxo normal — o handler
    // decide o que fazer com a nova mensagem (pode até gerar nova proposta).
    session = await sessionStore.upsert({ ...session, pendingProposal: null });
  }

  // ─── Step name: exige nome completo (nome + sobrenome) ────────────────────
  // Seguradoras rejeitam o calculate com "Nome não possui sobrenome" — caso real
  // observado 2026-05-19 quando o lead digitou "jeronimo" e o sistema avançou.
  if (session.stepId === 'name' && !looksLikeFullName(inbound.text)) {
    const reply = 'Pra cotar com as seguradoras preciso do nome completo (nome + sobrenome). Pode me passar?';
    await deps.send(reply);
    const persisted = await sessionStore.upsert(recordTurn(session, inbound, reply, 'ask_clarification'));
    return { replySent: reply, action: 'ask_clarification', sessionAfter: persisted };
  }

  // ─── Step vehicle_plate: decode automático + UX de confirmação inteligente ──
  // Fluxo:
  //   1. Lead manda placa → decode → OK: pula 3 steps. Falha: pergunta "está correta?"
  //   2. Lead confirma placa errada → fallback manual com mensagem clara.
  //   3. Lead manda placa corrigida → tenta de novo. Se falhar 2x, oferece manual.
  //   4. Skip explícito ("sem placa", "pular") → manual.
  if (session.stepId === 'vehicle_plate') {
    const promotedStage = session.pipelineStage === 'novos_leads' ? 'contatados' : session.pipelineStage;

    // ─── Helpers locais pra reaproveitar dentro do bloco ──────────────────────
    const goManualBrand = async (
      reply: string,
      action: string,
    ): Promise<{ replySent: string; action: AssistantAction; sessionAfter: SessionState }> => {
      const next: SessionState = {
        ...session,
        stepId: 'vehicle_brand',
        recentMessages: [],
        pendingProposal: null,
        pendingPlateConfirmation: null,
        pipelineStage: promotedStage,
      };
      await deps.send(reply);
      const persisted = await sessionStore.upsert(recordTurn(next, inbound, reply, action));
      return { replySent: reply, action: 'answer_step', sessionAfter: persisted };
    };

    const fillFromOutcome = async (
      plate: string,
      outcome: ReturnType<typeof pickPlateDecodeOutcome>,
    ): Promise<{ replySent: string; action: AssistantAction; sessionAfter: SessionState }> => {
      if (!outcome.brand || !outcome.model || !outcome.modelYear) {
        // Defensivo — não deveria chegar aqui com outcome.ok=true sem dados
        return goManualBrand(`Não consegui achar pela placa. Sem problema — ${STEP_PROMPT.vehicle_brand}`, 'plate_decode_failed');
      }
      const filled: SessionState = {
        ...session,
        answers: {
          ...session.answers,
          vehicle_plate: { id: 'vehicle_plate', label: 'Placa', value: plate, rawValue: plate },
          vehicle_brand: {
            id: 'vehicle_brand',
            label: 'Marca',
            value: outcome.brand.text,
            rawValue: outcome.brand.id,
            metadata: { brand_text: outcome.brand.text, brand_value: outcome.brand.value },
          },
          vehicle_year: {
            id: 'vehicle_year',
            label: 'Ano',
            value: String(outcome.modelYear),
            rawValue: String(outcome.modelYear),
          },
          vehicle_model: {
            id: 'vehicle_model',
            label: 'Modelo',
            value: outcome.model.value,
            rawValue: outcome.model.id,
            metadata: {
              model_id: outcome.model.id,
              fipe_code: outcome.model.fipeCode,
              fipe_value: outcome.model.fipeValue,
              fuel_type: outcome.model.fuelType,
              model_text: outcome.model.text,
            },
          },
        },
        stepId: 'usage',
        recentMessages: [],
        pendingProposal: null,
        pendingPlateConfirmation: null,
        pipelineStage: promotedStage,
      };
      const reply = `Anotei: ${outcome.brand.text} ${outcome.model.value} ${outcome.modelYear} 🚗\n\n${STEP_PROMPT.usage}`;
      await deps.send(reply);
      const persisted = await sessionStore.upsert(recordTurn(filled, inbound, reply, 'plate_decoded'));
      return { replySent: reply, action: 'answer_step', sessionAfter: persisted };
    };

    // ─── Tem confirmação pendente de placa? ────────────────────────────────────
    if (session.pendingPlateConfirmation) {
      const pending = session.pendingPlateConfirmation;

      // Skip explícito ainda funciona aqui
      if (looksLikeNoPlateSkip(inbound.text)) {
        return goManualBrand(`Sem problema. ${STEP_PROMPT.vehicle_brand}`, 'skip_plate');
      }

      // Lead confirmou que a placa está correta (mesmo decode falhando)
      if (looksLikeConfirmation(inbound.text)) {
        const reply = pending.finalOffer
          ? `Beleza. ${STEP_PROMPT.vehicle_brand}`
          : `Ok, como os dados não retornaram vou fazer algumas perguntas sobre o veículo.\n\n${STEP_PROMPT.vehicle_brand}`;
        return goManualBrand(reply, 'plate_confirmed_unfound');
      }

      // Lead negou — pede a placa de novo
      if (looksLikeDenial(inbound.text)) {
        const next: SessionState = {
          ...session,
          pendingPlateConfirmation: null,
          pipelineStage: promotedStage,
        };
        const reply = `Tá. Me passa a placa de novo, por favor.`;
        await deps.send(reply);
        const persisted = await sessionStore.upsert(recordTurn(next, inbound, reply, 'plate_retry'));
        return { replySent: reply, action: 'ask_clarification', sessionAfter: persisted };
      }

      // Tentou outra placa?
      const newPlate = extractPlateFromMessage(inbound.text);
      if (newPlate) {
        try {
          const resp = await decodePlate(newPlate);
          const outcome = pickPlateDecodeOutcome(resp.body);
          if (outcome.ok) {
            return fillFromOutcome(newPlate, outcome);
          }
        } catch (e) {
          console.warn(`decode-plate (retry) falhou: ${(e as Error).message}`);
        }
        // Nova placa também falhou → finalOffer
        const next: SessionState = {
          ...session,
          pendingPlateConfirmation: {
            plate: newPlate,
            attempts: pending.attempts + 1,
            finalOffer: true,
          },
          recentMessages: [],
          pipelineStage: promotedStage,
        };
        const reply = `Vi que você alterou, mas mesmo assim não retornou. Prefere me informar os dados do veículo manualmente?`;
        await deps.send(reply);
        const persisted = await sessionStore.upsert(recordTurn(next, inbound, reply, 'plate_decode_failed_again'));
        return { replySent: reply, action: 'ask_clarification', sessionAfter: persisted };
      }

      // Mensagem ambígua — deixa o handler IA processar
    }

    // ─── Skip imediato (sem proposta pendente) ─────────────────────────────────
    if (looksLikeNoPlateSkip(inbound.text)) {
      return goManualBrand(`Sem problema. ${STEP_PROMPT.vehicle_brand}`, 'skip_plate');
    }

    // ─── Primeira tentativa de placa ───────────────────────────────────────────
    const plate = extractPlateFromMessage(inbound.text);
    if (plate) {
      try {
        const resp = await decodePlate(plate);
        const outcome = pickPlateDecodeOutcome(resp.body);
        if (outcome.ok) {
          return fillFromOutcome(plate, outcome);
        }
      } catch (e) {
        console.warn(`decode-plate falhou: ${(e as Error).message}`);
      }
      // Decode falhou → pede confirmação da placa antes de cair pra manual
      const next: SessionState = {
        ...session,
        pendingPlateConfirmation: { plate, attempts: 1, finalOffer: false },
        recentMessages: [],
        pipelineStage: promotedStage,
      };
      const reply = `A placa informada não retornou o seu veículo. Confirme se está correta — Placa "${plate}"?`;
      await deps.send(reply);
      const persisted = await sessionStore.upsert(recordTurn(next, inbound, reply, 'plate_confirm_request'));
      return { replySent: reply, action: 'ask_clarification', sessionAfter: persisted };
    }
    // Sem placa identificada e sem pendência — handler IA pede esclarecimento.
  }

  // ─── Steps de CPF (document + main_driver_document): lookup automático ──────
  // Quando lead manda CPF válido, busca /insured no Segfy pra puxar nome+birth+sex
  // direto do cadastro — elimina perguntas redundantes (Jera 2026-05-17).
  if (session.stepId === 'document' || session.stepId === 'main_driver_document') {
    const cpf = extractValidCpf(inbound.text);
    if (cpf) {
      const promotedStage = session.pipelineStage === 'novos_leads' ? 'contatados' : session.pipelineStage;
      const lookup = await buscarCondutor(cpf);
      const insured = lookup.ok && lookup.data ? lookup.data : null;
      const cpfMasked = maskCpf(cpf);

      const baseAnswers: Record<string, { id: string; label: string; value: string; rawValue?: string; metadata?: Record<string, unknown> }> = { ...session.answers };

      if (session.stepId === 'document') {
        baseAnswers.document = { id: 'document', label: 'CPF', value: cpfMasked, rawValue: cpf };
        if (insured) {
          baseAnswers.driver_birth_date = {
            id: 'driver_birth_date',
            label: 'Nascimento',
            value: insured.birth_date,
            rawValue: insured.birth_date,
          };
          baseAnswers.driver_sex = {
            id: 'driver_sex',
            label: 'Sexo',
            value: insured.gender === 'male' ? 'Masculino' : 'Feminino',
            rawValue: insured.gender,
          };
        }
      } else {
        // main_driver_document
        baseAnswers.main_driver_document = { id: 'main_driver_document', label: 'CPF condutor', value: cpfMasked, rawValue: cpf };
        if (insured) {
          baseAnswers.main_driver_name = { id: 'main_driver_name', label: 'Nome condutor', value: insured.name, rawValue: insured.name };
          baseAnswers.main_driver_birth_date = { id: 'main_driver_birth_date', label: 'Nascimento condutor', value: insured.birth_date, rawValue: insured.birth_date };
          baseAnswers.main_driver_sex = { id: 'main_driver_sex', label: 'Sexo condutor', value: insured.gender === 'male' ? 'Masculino' : 'Feminino', rawValue: insured.gender };
        }
      }

      const nextStep = nextStepAfter(session.stepId as StepId, baseAnswers);
      const next: SessionState = {
        ...session,
        answers: baseAnswers,
        stepId: nextStep,
        recentMessages: [],
        pendingProposal: null,
        pipelineStage: promotedStage,
      };

      let ack: string;
      if (session.stepId === 'document') {
        ack = insured
          ? `CPF anotado ✅ — puxei seus dados do cadastro.`
          : `CPF anotado ✅`;
      } else {
        ack = insured
          ? `Beleza, condutor principal anotado: ${insured.name.split(/\s+/)[0]}.`
          : `CPF do condutor anotado ✅`;
      }
      const followUp = nextStep !== 'complete' && STEP_PROMPT[nextStep as StepId]
        ? `\n\n${STEP_PROMPT[nextStep as StepId]}`
        : '';
      const reply = `${ack}${followUp}`;
      await deps.send(reply);
      const persisted = await sessionStore.upsert(recordTurn(next, inbound, reply, 'cpf_lookup'));
      return { replySent: reply, action: 'answer_step', sessionAfter: persisted };
    }
    // CPF inválido — deixa o handler IA (local-rules) pedir correção
  }

  // Step quote_link com confirmação direta → dispara cotação sem passar pelo modelo.
  if (session.stepId === 'quote_link' && isCalcConfirmation(inbound.text)) {
    // ─── P2 — Idempotência: se já calculou nos últimos 60s, reenvia o link existente ──
    if (session.lastGuid && session.lastCalculateAt && Date.now() - session.lastCalculateAt < CALCULATE_IDEMPOTENCY_MS) {
      const link = buildQuoteLink(session.lastGuid);
      const reply = `Sua cotação ainda tá fresca aqui — pode abrir:\n${link}`;
      await deps.send(reply);
      const persisted = await sessionStore.upsert(recordTurn(session, inbound, reply, 'none', session.lastGuid));
      return { replySent: reply, action: 'none', sessionAfter: persisted };
    }

    const startReply = 'Fechado, vou calcular agora — isso leva uns segundos.';
    await deps.send(startReply);
    let calculatingSession = recordOutbound(recordInbound(session, inbound, 'calculate'), startReply, 'calculate');

    // ─── P5 — Nudge de progresso se Segfy demorar > 15s ──────────────────────────────
    const progressTimer = setTimeout(() => {
      deps.send('Tô esperando as seguradoras responderem, mais alguns segundinhos…').catch(() => undefined);
    }, PROGRESS_NUDGE_MS);

    let calc: Awaited<ReturnType<typeof triggerCalculate>>;
    try {
      calc = await triggerCalculate(inbound, session);
    } finally {
      clearTimeout(progressTimer);
    }

    if (!calc) {
      const fail = 'Não consegui concluir a cotação agora. Posso tentar novamente em alguns instantes?';
      await deps.send(fail);
      const persisted = await sessionStore.upsert(recordOutbound(calculatingSession, fail, 'calc_failed'));
      return { replySent: fail, action: 'calc_failed', sessionAfter: persisted };
    }
    calculatingSession = {
      ...calculatingSession,
      completed: true,
      stepId: 'complete',
      pipelineStage: calculatingSession.pipelineStage === 'vendas' || calculatingSession.pipelineStage === 'perdido'
        ? calculatingSession.pipelineStage
        : 'em_negociacao',
      lastGuid: calc.guid,
      lastCalculateAt: Date.now(),
      recentMessages: [],
      pendingProposal: null,
    };
    const updated = await sessionStore.upsert(recordOutbound(calculatingSession, calc.topReply, 'calculate', calc.guid));
    await deps.send(calc.topReply);
    return { replySent: calc.topReply, action: 'calculate', sessionAfter: updated };
  }

  // A esta altura os steps de intake (service_type/branch_select) já foram tratados
  // e retornaram acima — este guard estreita o tipo pra jornada e é inalcançável na prática.
  if (session.stepId === 'service_type' || session.stepId === 'branch_select') {
    return { replySent: null, action: 'none', sessionAfter: session };
  }

  // Carrega catálogo server-side se step exige.
  const catalogItems = await loadCatalogForStep(session.stepId, session.answers);

  const result = await handleAutoF1AssistantMessage({
    message: inbound.text,
    channel: 'whatsapp',
    tenantId,
    snapshot: {
      stepId: session.stepId === 'complete' ? 'quote_link' : session.stepId,
      completed: false,
      answers: session.answers,
      recentMessages: session.recentMessages,
    },
    catalogContext: { items: catalogItems.slice(0, 200) },
  });

  const safeForBuffer = maskCpfPii(inbound.text);

  let nextSession: SessionState = {
    ...session,
    pipelineStage: session.pipelineStage === 'novos_leads' ? 'contatados' : session.pipelineStage,
    recentMessages: [...session.recentMessages, safeForBuffer].slice(-5),
  };

  let replyToSend = result.reply;

  if (result.action === 'answer_step' && result.proposedAnswer) {
    const proposal = {
      stepId: result.proposedAnswer.stepId,
      value: result.proposedAnswer.value,
      displayLabel: result.proposedAnswer.displayLabel,
      metadata: result.proposedAnswer.metadata,
    };
    if (result.pendingConfirmation) {
      // P1 — Router usou pista anterior. Guarda como pending e NÃO avança step.
      // Próxima mensagem ("sim"/"não") é interceptada acima e decide.
      nextSession = { ...nextSession, pendingProposal: proposal };
    } else {
      // Avança normal: aplica answer no estado e move pro próximo step.
      nextSession = applyProposalAndAdvance(nextSession, proposal);
      // P8 — Concatena a pergunta do próximo step pra Robocotenão deixar
      // o lead no escuro depois do "Anotei". No WhatsApp não tem rail visual
      // mostrando o que vem em seguida — quem conduz é a fala dela.
      const nextStep = nextSession.stepId;
      if (nextStep !== 'complete' && STEP_PROMPT[nextStep as StepId]) {
        replyToSend = `${result.reply}\n\n${STEP_PROMPT[nextStep as StepId]}`;
      }
    }
  }

  const persisted = await sessionStore.upsert(recordTurn(nextSession, inbound, replyToSend, result.action));
  await deps.send(replyToSend);

  return { replySent: replyToSend, action: result.action, sessionAfter: persisted };
}
