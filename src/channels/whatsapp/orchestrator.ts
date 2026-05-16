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
import {
  sessionStore,
  createInitialSessionState,
  type SessionState,
  type SessionKey,
} from '../../session/store.js';
import type { EvolutionInboundMessage } from './evolution.js';
import { sendWhatsappText } from './evolution.js';

const ROBOCOTE_QUOTE_BASE_URL = process.env.ROBOCOTE_QUOTE_BASE_URL?.trim() ?? '';
const ROBOCOTE_TENANT_ID = process.env.ROBOCOTE_TENANT_ID?.trim() || 'rpi';

const GREETING_LINES = [
  'Olá! Eu sou a Vivi, corretora digital da Robocote 🚗',
  'Vou te ajudar a cotar seu seguro auto numa conversa simples. Pode responder do seu jeito.',
  'Pra começar, qual é seu nome completo?',
];

function maskCpfPii(value: string): string {
  return value
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '<CPF protegido>')
    .replace(/\b\d{5}-?\d{3}\b/g, '<CEP protegido>');
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

const CALCULATE_IDEMPOTENCY_MS = 60_000;
const PROGRESS_NUDGE_MS = 15_000;

function buildQuoteLink(guid: string): string {
  if (!ROBOCOTE_QUOTE_BASE_URL) return `/quote-room/${guid}`;
  return `${ROBOCOTE_QUOTE_BASE_URL.replace(/\/$/, '')}/quote-room/${guid}`;
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
    zip_code: getRaw('zip_code'),
    residence_type: getRaw('residence_type'),
    residence_garage: getRaw('residence_garage'),
    marital_status: getRaw('marital_status'),
    coverage: getRaw('coverage'),
    contact: getRaw('contact'),
    driver_birth_date: getRaw('driver_birth_date'),
    driver_sex: getRaw('driver_sex'),
    document: getRaw('document'),
  };
}

async function triggerCalculate(
  inbound: EvolutionInboundMessage,
  session: SessionState,
): Promise<{ guid: string; link: string; topReply: string } | null> {
  try {
    const request: AutoF1QuoteRequest = { answers: answersFromSession(session) };
    const result = await runAutoF1Quote(request, 45000);
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
): Promise<{ replySent: string | null; action: AssistantAction | 'greet' | 'calc_failed'; sessionAfter: SessionState | null }> {
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
    const greeting = GREETING_LINES.join('\n\n');
    await sendWhatsappText(inbound.fromPhone, greeting);
    return { replySent: greeting, action: 'greet', sessionAfter: session };
  }

  if (session.completed) {
    // Pós-cotação ainda não tem fluxo dedicado. Resposta gentil temporária.
    const reply = 'Sua cotação tá pronta acima. Em breve eu vou poder te explicar as opções por aqui também — por enquanto, dá uma olhada no link que mandei.';
    await sendWhatsappText(inbound.fromPhone, reply);
    return { replySent: reply, action: 'none', sessionAfter: session };
  }

  // ─── P1 — Proposta pendente aguardando confirmação ──────────────────────────────
  // Quando a Vivi propôs algo usando pista anterior e marcou pendingConfirmation,
  // a próxima mensagem do lead pode ser "sim/não". Interceptamos antes do handler
  // pra evitar que "sim" vire resposta do próximo step.
  if (session.pendingProposal) {
    const pending = session.pendingProposal;

    if (looksLikeConfirmation(inbound.text)) {
      const advanced = applyProposalAndAdvance(session, pending);
      const persisted = await sessionStore.upsert(advanced);
      const next = persisted.stepId;
      const ack = `Anotei: ${pending.displayLabel ?? pending.value}.`;
      const followUp = next !== 'complete' && STEP_PROMPT[next as StepId]
        ? `\n\n${STEP_PROMPT[next as StepId]}`
        : '';
      const reply = `${ack}${followUp}`;
      await sendWhatsappText(inbound.fromPhone, reply);
      return { replySent: reply, action: 'answer_step', sessionAfter: persisted };
    }

    if (looksLikeDenial(inbound.text)) {
      const cleared = await sessionStore.upsert({ ...session, pendingProposal: null });
      const currentStep = session.stepId === 'complete' ? 'quote_link' : session.stepId;
      const prompt = STEP_PROMPT[currentStep as StepId] ?? 'Me passa o dado de novo, por favor.';
      const reply = `Beleza, vou refazer. ${prompt}`;
      await sendWhatsappText(inbound.fromPhone, reply);
      return { replySent: reply, action: 'ask_clarification', sessionAfter: cleared };
    }

    // Mensagem ambígua: limpa proposta pendente e segue fluxo normal — o handler
    // decide o que fazer com a nova mensagem (pode até gerar nova proposta).
    session = await sessionStore.upsert({ ...session, pendingProposal: null });
  }

  // Step quote_link com confirmação direta → dispara cotação sem passar pelo modelo.
  if (session.stepId === 'quote_link' && isCalcConfirmation(inbound.text)) {
    // ─── P2 — Idempotência: se já calculou nos últimos 60s, reenvia o link existente ──
    if (session.lastGuid && session.lastCalculateAt && Date.now() - session.lastCalculateAt < CALCULATE_IDEMPOTENCY_MS) {
      const link = buildQuoteLink(session.lastGuid);
      const reply = `Sua cotação ainda tá fresca aqui — pode abrir:\n${link}`;
      await sendWhatsappText(inbound.fromPhone, reply);
      return { replySent: reply, action: 'none', sessionAfter: session };
    }

    await sendWhatsappText(inbound.fromPhone, 'Fechado, vou calcular agora — isso leva uns segundos.');

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
      return { replySent: fail, action: 'calc_failed', sessionAfter: session };
    }
    const updated = await sessionStore.upsert({
      ...session,
      completed: true,
      stepId: 'complete',
      lastGuid: calc.guid,
      lastCalculateAt: Date.now(),
      recentMessages: [],
      pendingProposal: null,
    });
    await sendWhatsappText(inbound.fromPhone, calc.topReply);
    return { replySent: calc.topReply, action: 'calculate', sessionAfter: updated };
  }

  // Carrega catálogo server-side se step exige.
  const catalogItems = await loadCatalogForStep(session.stepId, session.answers);

  const result = await handleAutoF1AssistantMessage({
    message: inbound.text,
    channel: 'whatsapp',
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
      // P8 — Concatena a pergunta do próximo step pra Vivi não deixar
      // o lead no escuro depois do "Anotei". No WhatsApp não tem rail visual
      // mostrando o que vem em seguida — quem conduz é a fala dela.
      const nextStep = nextSession.stepId;
      if (nextStep !== 'complete' && STEP_PROMPT[nextStep as StepId]) {
        replyToSend = `${result.reply}\n\n${STEP_PROMPT[nextStep as StepId]}`;
      }
    }
  }

  const persisted = await sessionStore.upsert(nextSession);
  await sendWhatsappText(inbound.fromPhone, replyToSend);

  return { replySent: replyToSend, action: result.action, sessionAfter: persisted };
}

const STEP_ORDER = [
  'name',
  'vehicle_brand',
  'vehicle_year',
  'vehicle_model',
  'usage',
  'renewal_status',
  'zip_code',
  'residence_type',
  'residence_garage',
  'marital_status',
  'coverage',
  'contact',
  'driver_birth_date',
  'driver_sex',
  'document',
  'quote_link',
] as const;

type StepId = (typeof STEP_ORDER)[number];

function nextStepAfter(stepId: StepId): SessionState['stepId'] {
  const idx = STEP_ORDER.indexOf(stepId);
  if (idx === -1 || idx >= STEP_ORDER.length - 1) return 'complete';
  return STEP_ORDER[idx + 1] ?? 'complete';
}

/** Pergunta padrão da Vivi pra cada step — usado quando avançamos via confirmação direta. */
const STEP_PROMPT: Record<StepId, string> = {
  name: 'Pra começar, qual é seu nome completo?',
  vehicle_brand: 'Qual é a marca do veículo?',
  vehicle_year: 'Qual o ano do veículo?',
  vehicle_model: 'Qual modelo do veículo?',
  usage: 'O uso é pessoal, trabalho ou empresa/frota?',
  renewal_status: 'É seguro novo ou renovação?',
  zip_code: 'Qual o CEP de residência? Pode mandar só os números.',
  residence_type: 'Mora em casa ou apartamento?',
  residence_garage: 'Tem garagem? Se sim, com ou sem portão eletrônico?',
  marital_status: 'Qual seu estado civil? Solteiro, casado, divorciado ou viúvo.',
  coverage: 'Na decisão, prioriza economia, equilíbrio ou proteção?',
  contact: 'Qual WhatsApp o corretor pode usar pra continuar? (pode pular se quiser)',
  driver_birth_date: 'Data de nascimento do condutor? (DD/MM/AAAA)',
  driver_sex: 'Sexo do condutor — masculino ou feminino?',
  document: 'Última coisa antes do cálculo: me passa o CPF. As seguradoras consultam Serasa pra precificar — fica protegido com criptografia.',
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
  return {
    ...session,
    answers: {
      ...session.answers,
      [stepId]: {
        id: stepId,
        label: stepId,
        value: proposal.displayLabel ?? proposal.value,
        rawValue: proposal.value,
        metadata: proposal.metadata,
      },
    },
    stepId: nextStepAfter(stepId),
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
