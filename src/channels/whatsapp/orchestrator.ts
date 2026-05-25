/**
 * Orquestrador WhatsApp: cola sessão + handler conversacional + envio de resposta.
 *
 * Caminho feliz por turno:
 *   1. Resolve sessão pelo (tenantId, phone) — cria se não existe.
 *   2. Se sessão é nova: envia saudação inicial e fica em step `name`.
 *   3. Senão: monta AssistantRequest do estado atual + mensagem nova,
 *      chama handleAutoF1AssistantMessage, aplica resposta (avança step / mantém),
 *      persiste novo estado, envia reply pelo Evolution.
 *   4. Em action=calculate: dispara runAutoF1Quote, manda link do Quote Room.
 *
 * Caminhos não cobertos nesta rodada (próximos):
 *   - Conversa pós-cotação (lead pergunta sobre opções recebidas).
 *   - Retomada explícita ("oi de novo" depois de dias — hoje a sessão sobrevive 7 dias).
 *   - Reset por palavra-chave (lead digita "reiniciar").
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
} from '../../session/store.js';
import type { EvolutionInboundMessage } from './evolution.js';
import { sendWhatsappText } from './evolution.js';
import { getAgentName } from '../../tenant/agent.js';
import { cacheQuoteContext } from '../../quote/contextCache.js';

const ROBOCOTE_QUOTE_BASE_URL = process.env.ROBOCOTE_QUOTE_BASE_URL?.trim() ?? '';
const ROBOCOTE_TENANT_ID = process.env.ROBOCOTE_TENANT_ID?.trim() || 'rpi';

function buildGreeting(agentName: string): string[] {
  return [
    `Olá! Eu sou o ${agentName}, o seu corretor digital inteligente.`,
    'Vou te ajudar a cotar seu seguro auto numa conversa simples. Pode responder do seu jeito.',
    'Pra começar, qual é seu nome completo?',
  ];
}

function isLikelyCpfDigits(digits: string): boolean {
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const calc = (factor: number): number => {
    const total = digits
      .slice(0, factor - 1)
      .split('')
      .reduce((sum, d, i) => sum + Number(d) * (factor - i), 0);
    const mod = (total * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(10) === Number(digits[9]) && calc(11) === Number(digits[10]);
}

function maskCpfPii(value: string): string {
  return value
    // CNPJ pontuado primeiro (formato único, sem ambiguidade)
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '<CNPJ protegido>')
    // CPF: formato pontuado SEMPRE mascara; cru 11 dígitos só se passar em DV
    // (telefone 48988326647 não passa, então fica intacto pra próxima regra)
    .replace(/\b(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})\b/g, (match, a, b, c, d) => {
      if (/[.\-]/.test(match)) return '<CPF protegido>';
      const digits = `${a}${b}${c}${d}`;
      return isLikelyCpfDigits(digits) ? '<CPF protegido>' : match;
    })
    // Telefone (BR celular) — cobre o caso 11 dígitos crus que NÃO eram CPF
    .replace(/\b(?:\+?55\s*)?\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, '<telefone protegido>')
    // CEP: pontuado ou cru, MAS não mascarar se parecer data de nascimento DDMMAAAA
    .replace(/\b(\d{5})-(\d{3})\b/g, '<CEP protegido>')
    .replace(/\b(\d{2})(\d{2})(\d{4})\b/g, (match, dd, mm, yyyy) => {
      const dDay = Number(dd);
      const mMonth = Number(mm);
      const yYear = Number(yyyy);
      // DDMMAAAA plausível pra data de nascimento → não mascara
      if (dDay >= 1 && dDay <= 31 && mMonth >= 1 && mMonth <= 12 && (yYear >= 1900 && yYear <= 2030)) {
        return match;
      }
      // Caso contrário, 8 dígitos = CEP cru
      return '<CEP protegido>';
    });
}

function normalizeMsg(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\w\s]/g, ' ')
    .trim();
}

function isCalcConfirmation(message: string): boolean {
  return /\b(sim|pode|calcula|calcular|manda|bora|gerar|ok|vamos|vai)\b/i.test(message);
}

/** Lead confirmou uma proposta pendente ("sim", "confere", "isso" etc). */
function looksLikeConfirmation(message: string): boolean {
  const m = normalizeMsg(message);
  if (!m) return false;
  if (/^(sim|s|isso|exato|exatamente|certo|correto|confere|positivo|ok|beleza|certinho|claro|perfeito|esse|esse mesmo|esse mesmo sim|e isso|e isso mesmo|e esse|tudo certo|pode ser|pode|fechou|fechado)$/.test(m)) return true;
  if (/^(é|eh)\s*(isso|esse|sim)?$/.test(m)) return true;
  return false;
}

/** Lead negou uma proposta pendente. */
function looksLikeDenial(message: string): boolean {
  const m = normalizeMsg(message);
  if (!m) return false;
  if (/^(nao|n|errado|errou|negativo|nem|nada disso|nao e|nao e isso|nao e esse|outro|outra)$/.test(m)) return true;
  return false;
}

/**
 * Lead enviou nome completo (mínimo nome + sobrenome com 2+ chars cada).
 * Necessário porque seguradoras rejeitam o calculate com "Nome não possui sobrenome"
 * — bug observado 2026-05-19 quando lead digitou só "jeronimo" e o sistema avançou.
 * Aceita acentos, hífens (Maria-José) e apóstrofos (D'Angelo).
 */
function looksLikeFullName(message: string): boolean {
  const cleaned = (message ?? '')
    .trim()
    .replace(/[^A-Za-zÀ-ÿ\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleaned.split(' ').filter((p) => p.length >= 2);
  return parts.length >= 2;
}

/**
 * Lead quer reiniciar a conversa (palavra-chave em qualquer ponto, ou intenção de
 * nova cotação quando a anterior já fechou). Em sessão `completed`, aceita gatilhos
 * mais frouxos ("outro carro", "outro seguro") porque o lead não tem mais nada
 * pra discutir no estado atual além de cotar de novo.
 */
function isResetIntent(message: string, completed: boolean): boolean {
  const m = normalizeMsg(message);
  if (!m) return false;
  if (/\b(reiniciar|recome[cç]ar|come[cç]ar de novo|come[cç]ar do zero|do zero|do come[cç]o|do inicio|nova cota[cç][aã]o|outra cota[cç][aã]o|cotar de novo|nova cotacao|outra cotacao)\b/.test(m)) return true;
  if (completed && /\b(outro carro|outra moto|outro seguro|outro ve[ií]culo|novo carro|nova cota)\b/.test(m)) return true;
  return false;
}

const CALCULATE_IDEMPOTENCY_MS = 60_000;
const PROGRESS_NUDGE_MS = 15_000;

/** Lead avisa que não tem/quer mandar placa ("sem placa", "não tenho", "pular"). */
function looksLikeNoPlateSkip(message: string): boolean {
  const m = normalizeMsg(message);
  if (!m) return false;
  return /^(sem\s*placa|pular|skip|sem|nao\s*tenho|nao\s*sei|nao\s*lembro|nao\s*sei\s*ainda|nao\s*tenho\s*aqui|nao\s*tenho\s*comigo|nao|n)$/.test(m);
}

/** Extrai padrão de placa (Mercosul AAA1A23 ou antigo AAA1234) dentro de qualquer texto. */
function extractPlateFromMessage(message: string): string | null {
  const matches = message.match(/[A-Za-z]{3}[\s-]?[0-9][0-9A-Za-z][0-9]{2}/g);
  if (!matches) return null;
  for (const m of matches) {
    if (isValidPlateFormat(m)) return normalizePlate(m);
  }
  return null;
}

/** Extrai CPF válido (com DV correto) de qualquer mensagem. */
function extractValidCpf(text: string): string | null {
  const match = text.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, '');
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return null;
  const calc = (factor: number): number => {
    const total = digits
      .slice(0, factor - 1)
      .split('')
      .reduce((sum, d, i) => sum + Number(d) * (factor - i), 0);
    const mod = (total * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(10) === Number(digits[9]) && calc(11) === Number(digits[10]) ? digits : null;
}

function maskCpf(digits: string): string {
  if (digits.length !== 11) return '<CPF protegido>';
  return `${digits.slice(0, 3)}.***.***-${digits.slice(9)}`;
}

function buildQuoteLink(guid: string): string {
  if (!ROBOCOTE_QUOTE_BASE_URL) return `/quote-room/${guid}`;
  return `${ROBOCOTE_QUOTE_BASE_URL.replace(/\/$/, '')}/quote-room/${guid}`;
}

function recordInbound(
  session: SessionState,
  inbound: EvolutionInboundMessage,
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
  inbound: EvolutionInboundMessage,
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
  inbound: EvolutionInboundMessage,
  session: SessionState,
): Promise<{ guid: string; link: string; topReply: string } | null> {
  try {
    const request: AutoF1QuoteRequest = { answers: answersFromSession(session) };
    const result = await runAutoF1Quote(request, 45000);
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
 * Processa uma mensagem inbound do WhatsApp.
 * Retorna o que foi enviado de volta (pra logging/teste), ou null se ignorou.
 */
export async function processWhatsappTurn(
  inbound: EvolutionInboundMessage,
  options: { tenantId?: string } = {},
): Promise<{ replySent: string | null; action: AssistantAction | 'greet' | 'calc_failed' | 'reset'; sessionAfter: SessionState | null }> {
  if (inbound.fromSelf) {
    return { replySent: null, action: 'none', sessionAfter: null };
  }

  const tenantId = options.tenantId ?? ROBOCOTE_TENANT_ID;
  const key: SessionKey = { tenantId, channel: 'whatsapp', channelUserId: inbound.fromPhone };

  let session = await sessionStore.get(key);
  const isNew = !session;
  if (!session) {
    session = await sessionStore.upsert(createInitialSessionState(key));
  }

  // Primeira mensagem: envia saudação e fica aguardando o nome.
  if (isNew) {
    const agentName = await getAgentName(tenantId);
    const greeting = buildGreeting(agentName).join('\n\n');
    await sendWhatsappText(inbound.fromPhone, greeting);
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
    await sendWhatsappText(inbound.fromPhone, greeting);
    const persisted = await sessionStore.upsert(recordTurn(fresh, inbound, greeting, 'reset'));
    return { replySent: greeting, action: 'reset', sessionAfter: persisted };
  }

  if (session.completed) {
    // Pós-cotação ainda não tem fluxo dedicado. Resposta gentil temporária.
    const reply = 'Sua cotação tá pronta acima. Em breve eu vou poder te explicar as opções por aqui também — por enquanto, dá uma olhada no link que mandei.\n\nSe quiser fazer outra cotação, é só dizer "nova cotação" que eu recomeço.';
    await sendWhatsappText(inbound.fromPhone, reply);
    const persisted = await sessionStore.upsert(recordTurn(session, inbound, reply, 'none'));
    return { replySent: reply, action: 'none', sessionAfter: persisted };
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
      await sendWhatsappText(inbound.fromPhone, reply);
      const persisted = await sessionStore.upsert(recordTurn(advanced, inbound, reply, 'answer_step'));
      return { replySent: reply, action: 'answer_step', sessionAfter: persisted };
    }

    if (looksLikeDenial(inbound.text)) {
      const currentStep = session.stepId === 'complete' ? 'quote_link' : session.stepId;
      const prompt = STEP_PROMPT[currentStep as StepId] ?? 'Me passa o dado de novo, por favor.';
      const reply = `Beleza, vou refazer. ${prompt}`;
      await sendWhatsappText(inbound.fromPhone, reply);
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
    await sendWhatsappText(inbound.fromPhone, reply);
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
      await sendWhatsappText(inbound.fromPhone, reply);
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
      await sendWhatsappText(inbound.fromPhone, reply);
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
        await sendWhatsappText(inbound.fromPhone, reply);
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
        await sendWhatsappText(inbound.fromPhone, reply);
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
      await sendWhatsappText(inbound.fromPhone, reply);
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
      await sendWhatsappText(inbound.fromPhone, reply);
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
      await sendWhatsappText(inbound.fromPhone, reply);
      const persisted = await sessionStore.upsert(recordTurn(session, inbound, reply, 'none', session.lastGuid));
      return { replySent: reply, action: 'none', sessionAfter: persisted };
    }

    const startReply = 'Fechado, vou calcular agora — isso leva uns segundos.';
    await sendWhatsappText(inbound.fromPhone, startReply);
    let calculatingSession = recordOutbound(recordInbound(session, inbound, 'calculate'), startReply, 'calculate');

    // ─── P5 — Nudge de progresso se Segfy demorar > 15s ──────────────────────────────
    const progressTimer = setTimeout(() => {
      sendWhatsappText(inbound.fromPhone, 'Tô esperando as seguradoras responderem, mais alguns segundinhos…').catch(() => undefined);
    }, PROGRESS_NUDGE_MS);

    let calc: Awaited<ReturnType<typeof triggerCalculate>>;
    try {
      calc = await triggerCalculate(inbound, session);
    } finally {
      clearTimeout(progressTimer);
    }

    if (!calc) {
      const fail = 'Não consegui concluir a cotação agora. Posso tentar novamente em alguns instantes?';
      await sendWhatsappText(inbound.fromPhone, fail);
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
    await sendWhatsappText(inbound.fromPhone, calc.topReply);
    return { replySent: calc.topReply, action: 'calculate', sessionAfter: updated };
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
  await sendWhatsappText(inbound.fromPhone, replyToSend);

  return { replySent: replyToSend, action: result.action, sessionAfter: persisted };
}

const STEP_ORDER = [
  'name',
  'vehicle_plate',
  'vehicle_brand',
  'vehicle_year',
  'vehicle_model',
  'usage',
  'renewal_status',
  'renewal_bonus',
  'zip_code',
  'residence_type',
  'residence_garage',
  'marital_status',
  'coverage',
  'contact',
  'is_main_driver',
  'main_driver_document',
  'young_driver',
  'studies',
  'study_garage',
  'work_commute',
  'work_garage',
  'monthly_km',
  'document',
  'driver_birth_date',
  'driver_sex',
  'quote_link',
] as const;

type StepId = (typeof STEP_ORDER)[number];

/**
 * Decide se um step deve ser PULADO com base nas respostas já dadas.
 * Steps condicionais do questionário de risco (Jera 2026-05-17).
 */
function shouldSkipStep(stepId: StepId, answers: Record<string, { rawValue?: string; value?: string }>): boolean {
  if (stepId === 'main_driver_document') {
    return answers.is_main_driver?.rawValue === 'yes';
  }
  if (stepId === 'study_garage') {
    return answers.studies?.rawValue !== 'yes';
  }
  if (stepId === 'work_garage') {
    return answers.work_commute?.rawValue !== 'yes';
  }
  // renewal_bonus só pergunta se o lead disse "renovação" no step anterior.
  // Novo seguro não usa bônus, payload Segfy vai com insurer='new' direto.
  if (stepId === 'renewal_bonus') {
    const v = (answers.renewal_status?.rawValue ?? answers.renewal_status?.value ?? '').toLowerCase();
    return !/reno|renew/.test(v);
  }
  // driver_birth_date e driver_sex só aparecem como FALLBACK quando o lookup
  // /insured falhou (ou seja, ainda não estão preenchidos nos answers).
  if (stepId === 'driver_birth_date') {
    return Boolean(answers.driver_birth_date?.rawValue);
  }
  if (stepId === 'driver_sex') {
    return Boolean(answers.driver_sex?.rawValue);
  }
  return false;
}

function nextStepAfter(stepId: StepId, answers: Record<string, { rawValue?: string; value?: string }> = {}): SessionState['stepId'] {
  const idx = STEP_ORDER.indexOf(stepId);
  if (idx === -1 || idx >= STEP_ORDER.length - 1) return 'complete';
  for (let i = idx + 1; i < STEP_ORDER.length; i += 1) {
    const candidate = STEP_ORDER[i];
    if (!shouldSkipStep(candidate, answers)) return candidate;
  }
  return 'complete';
}

/** Pergunta padrão da Robocotepra cada step — usado quando avançamos via confirmação direta. */
const STEP_PROMPT: Record<StepId, string> = {
  name: 'Pra começar, qual é seu nome completo?',
  vehicle_plate: 'Tem a placa do carro à mão? Mandando a placa, eu acelero a cotação. Sem placa também funciona — é só dizer.',
  vehicle_brand: 'Qual é a marca do veículo?',
  vehicle_year: 'Qual o ano do veículo?',
  vehicle_model: 'Qual modelo do veículo?',
  usage: 'O uso é pessoal, trabalho ou empresa/frota?',
  renewal_status: 'É seguro novo ou renovação?',
  renewal_bonus: 'Qual é a sua classe de bônus atual? (de 0 a 10 — se não souber, é só dizer 0)',
  zip_code: 'Qual o CEP de residência? Pode mandar só os números.',
  residence_type: 'Mora em casa ou apartamento?',
  residence_garage: 'Tem garagem? Se sim, com ou sem portão eletrônico?',
  marital_status: 'Qual seu estado civil? Solteiro, casado, divorciado ou viúvo.',
  coverage: 'Na decisão, prioriza economia, equilíbrio ou proteção?',
  contact: 'Qual WhatsApp o corretor pode usar pra continuar? (pode pular se quiser)',
  is_main_driver: 'Você é quem dirige o carro na maior parte do tempo, ou é outra pessoa?',
  main_driver_document: 'Beleza. Me passa o CPF de quem dirige principalmente — uso pra buscar os dados direto no cadastro.',
  young_driver: 'Mais alguém com menos de 26 anos mora com você e dirige esse carro? (Isso pode pesar no preço final.)',
  studies: 'Você estuda atualmente?',
  study_garage: 'No local onde estuda, tem garagem fechada pra deixar o carro?',
  work_commute: 'Usa o carro pra ir e voltar do trabalho?',
  work_garage: 'No trabalho, tem garagem fechada pra deixar o carro?',
  monthly_km: 'Quantos quilômetros você roda por mês, mais ou menos? Pode ser estimativa.',
  document: 'Última coisa antes do cálculo: me passa o CPF. As seguradoras consultam Serasa pra precificar — fica protegido com criptografia.',
  driver_birth_date: 'Não consegui puxar seus dados cadastrais. Pode me passar a sua data de nascimento? (DD/MM/AAAA)',
  driver_sex: 'E o sexo que consta no cadastro — masculino ou feminino?',
  quote_link: 'Pronto. Posso calcular agora?',
};

function extractFirstName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

function normalizeCoverage(value: string): SessionState['coveragePreference'] {
  const v = value.trim().toLowerCase();
  if (v.includes('economia')) return 'Economia';
  if (v.includes('equilib') || v.includes('equilíb')) return 'Equilíbrio';
  if (v.includes('prote')) return 'Proteção';
  return null;
}

/**
 * Aplica uma proposta como answer no estado da sessão e avança pro próximo step.
 * Usado tanto quando o lead confirma uma pendingProposal quanto quando o router
 * decide answer_step direto (sem confirmação pendente).
 */
function applyProposalAndAdvance(
  session: SessionState,
  proposal: {
    stepId: string;
    value: string;
    displayLabel?: string;
    metadata?: Record<string, unknown>;
  },
): SessionState {
  const stepId = proposal.stepId as StepId;
  const updatedAnswers = {
    ...session.answers,
    [stepId]: {
      id: stepId,
      label: stepId,
      value: proposal.displayLabel ?? proposal.value,
      rawValue: proposal.value,
      metadata: proposal.metadata,
    },
  };
  return {
    ...session,
    answers: updatedAnswers,
    stepId: nextStepAfter(stepId, updatedAnswers),
    recentMessages: [],
    pendingProposal: null,
    customerFirstName: stepId === 'name'
      ? (extractFirstName(proposal.value) ?? session.customerFirstName)
      : session.customerFirstName,
    coveragePreference: stepId === 'coverage'
      ? normalizeCoverage(proposal.value)
      : session.coveragePreference,
  };
}
