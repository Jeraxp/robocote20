import { z } from 'zod';
import { getRobocotePersona } from './persona.js';
import { loadCatalogForStep, stepNeedsCatalog } from '../catalog/auto.js';

const TASKDUN_AI_BASE_URL = process.env.TASKDUN_AI_BASE_URL?.trim() ?? '';
const TASKDUN_AI_API_KEY = process.env.TASKDUN_AI_API_KEY?.trim() ?? '';
const TASKDUN_AI_CHAT_PATH = process.env.TASKDUN_AI_CHAT_PATH?.trim() ?? '/v1/chat/completions';
const ROBOCOTE_EXTRACTOR_MODEL = process.env.ROBOCOTE_EXTRACTOR_MODEL?.trim() || 'gpt-5.4-mini';
const ROBOCOTE_DIALOG_MODEL = process.env.ROBOCOTE_DIALOG_MODEL?.trim() || 'gpt-5.3-chat-latest';
const ROBOCOTE_ANALYST_MODEL = process.env.ROBOCOTE_ANALYST_MODEL?.trim() || 'gpt-5.4';

const ACTIVE_STEPS = [
  'name',
  'vehicle_plate',
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

type ActiveStepId = (typeof ACTIVE_STEPS)[number];

const channelSchema = z.enum(['webchat', 'whatsapp']).optional().default('webchat');
type Channel = z.infer<typeof channelSchema>;

const catalogItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const assistantRequestSchema = z.object({
  message: z.string().trim().min(1).max(1400),
  channel: channelSchema,
  snapshot: z.object({
    stepId: z.enum(ACTIVE_STEPS),
    completed: z.boolean().optional().default(false),
    answers: z.record(z.object({
      id: z.string(),
      label: z.string(),
      value: z.string(),
      rawValue: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })).optional().default({}),
    // Últimas mensagens do lead que NÃO viraram answer_step ainda.
    // Permite à Robocotelembrar de pistas anteriores (ex: lead mencionou modelo no step de ano).
    // PII deve estar mascarada pelo frontend antes de chegar aqui.
    recentMessages: z.array(z.string().max(400)).max(5).optional().default([]),
  }),
  catalogContext: z.object({
    items: z.array(catalogItemSchema).max(200).optional().default([]),
  }).optional().default({ items: [] }),
});

const routerResponseSchema = z.object({
  mode: z.enum(['capture', 'consult']).optional().default('capture'),
  action: z.enum(['answer_step', 'ask_clarification', 'consult_reply', 'calculate', 'none']),
  value: z.string().optional().default(''),
  displayLabel: z.string().optional().default(''),
  consultTopic: z.string().optional().default(''),
  confidence: z.number().min(0).max(1).optional().default(0.5),
});

const replyResponseSchema = z.object({
  reply: z.string().trim().min(1).max(720),
});

export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
type RouterResponse = z.infer<typeof routerResponseSchema>;

export type AssistantAction = 'answer_step' | 'ask_clarification' | 'consult_reply' | 'calculate' | 'none';
export type AssistantMode = 'capture' | 'consult';

export interface AssistantStepAnswer {
  stepId: ActiveStepId;
  value: string;
  displayLabel?: string;
  metadata?: Record<string, unknown>;
  confidence: number;
}

export interface AssistantResponse {
  ok: true;
  source: 'taskdun-ai' | 'local-rules';
  configured: boolean;
  mode: AssistantMode;
  action: AssistantAction;
  stepId: ActiveStepId;
  channel: Channel;
  reply: string;
  proposedAnswer?: AssistantStepAnswer;
  /**
   * Quando true, a `proposedAnswer` veio de pista anterior (não da mensagem atual).
   * O orquestrador NÃO avança o step automaticamente — guarda como proposta pendente
   * e espera "sim/não" explícito do lead. Evita "sim" do lead virar resposta do próximo step.
   */
  pendingConfirmation?: boolean;
}

type Choice = { label: string; value: string; terms: string[] };

const CHOICES: Partial<Record<ActiveStepId, Choice[]>> = {
  usage: [
    { label: 'Uso pessoal', value: 'Uso pessoal', terms: ['pessoal', 'familia', 'família', 'lazer'] },
    { label: 'Trabalho/visitas', value: 'Trabalho/visitas', terms: ['trabalho', 'visita', 'visitas', 'cliente', 'clientes'] },
    { label: 'Empresa/frota', value: 'Empresa/frota', terms: ['empresa', 'frota', 'pj'] },
  ],
  renewal_status: [
    { label: 'Seguro novo', value: 'new', terms: ['novo', 'primeiro', 'sem seguro'] },
    { label: 'Renovação', value: 'renewal', terms: ['renovacao', 'renovação', 'apolice', 'apólice'] },
  ],
  residence_type: [
    { label: 'Casa', value: 'house', terms: ['casa', 'sobrado'] },
    { label: 'Apartamento', value: 'apartment', terms: ['apartamento', 'apto', 'condominio', 'condomínio'] },
  ],
  residence_garage: [
    { label: 'Sim, com portão eletrônico', value: 'yes_with_electronic_gate', terms: ['eletronico', 'eletrônico', 'automatico', 'automático'] },
    { label: 'Sim, sem portão eletrônico', value: 'yes_no_electronic_gate', terms: ['sem portao', 'sem portão', 'garagem sim', 'tenho garagem'] },
    { label: 'Não tenho', value: 'no_garage', terms: ['nao tenho', 'não tenho', 'rua', 'sem garagem'] },
  ],
  marital_status: [
    { label: 'Solteiro(a)', value: 'single', terms: ['solteiro', 'solteira'] },
    { label: 'Casado(a)', value: 'married', terms: ['casado', 'casada', 'uniao', 'união'] },
    { label: 'Divorciado(a)', value: 'divorced', terms: ['divorciado', 'divorciada', 'separado', 'separada'] },
    { label: 'Viúvo(a)', value: 'widowed', terms: ['viuvo', 'viúvo', 'viuva', 'viúva'] },
  ],
  coverage: [
    { label: 'Economia', value: 'Economia', terms: ['economia', 'barato', 'menor preço', 'menor preco'] },
    { label: 'Equilíbrio', value: 'Equilíbrio', terms: ['equilibrio', 'equilíbrio', 'meio termo', 'custo beneficio', 'custo-benefício'] },
    { label: 'Proteção', value: 'Proteção', terms: ['protecao', 'proteção', 'completo', 'melhor cobertura'] },
  ],
  driver_sex: [
    { label: 'Masculino', value: 'male', terms: ['masculino', 'homem', 'male', 'm'] },
    { label: 'Feminino', value: 'female', terms: ['feminino', 'mulher', 'female', 'f'] },
  ],
};

const STEP_CONTEXT: Record<ActiveStepId, { title: string; prompt: string }> = {
  name: { title: 'Nome', prompt: 'Qual é seu nome completo?' },
  vehicle_plate: { title: 'Placa', prompt: 'Tem a placa do carro à mão? Mandando a placa, eu acelero a cotação. Sem placa também funciona — é só dizer.' },
  vehicle_brand: { title: 'Marca', prompt: 'Qual é a marca do veículo?' },
  vehicle_year: { title: 'Ano', prompt: 'Qual o ano do veículo?' },
  vehicle_model: { title: 'Modelo', prompt: 'Qual modelo do veículo?' },
  usage: { title: 'Uso', prompt: 'Qual é o uso principal do veículo?' },
  renewal_status: { title: 'Renovação', prompt: 'É um seguro novo ou renovação de apólice atual?' },
  zip_code: { title: 'CEP', prompt: 'Qual é o CEP de residência?' },
  residence_type: { title: 'Residência', prompt: 'Mora em casa ou apartamento?' },
  residence_garage: { title: 'Garagem', prompt: 'Tem garagem na residência?' },
  marital_status: { title: 'Estado civil', prompt: 'Qual é o estado civil?' },
  coverage: { title: 'Perfil', prompt: 'Quer priorizar economia, equilíbrio ou proteção?' },
  contact: { title: 'Contato', prompt: 'Qual WhatsApp o corretor pode usar para continuar?' },
  driver_birth_date: { title: 'Nascimento', prompt: 'Qual é a data de nascimento do condutor?' },
  driver_sex: { title: 'Sexo', prompt: 'Qual sexo consta no cadastro do condutor?' },
  document: { title: 'CPF', prompt: 'Qual CPF devemos usar para disparar a cotação oficial?' },
  quote_link: { title: 'Link', prompt: 'Pronto para calcular na Segfy e abrir a sala consultiva?' },
};

function configured(): boolean {
  return Boolean(TASKDUN_AI_BASE_URL && TASKDUN_AI_API_KEY);
}

function channelLimits(channel: Channel): { maxChars: number; humanLabel: string } {
  return channel === 'whatsapp'
    ? { maxChars: 280, humanLabel: 'WhatsApp' }
    : { maxChars: 420, humanLabel: 'webchat' };
}

function truncateReply(reply: string, channel: Channel): string {
  const { maxChars } = channelLimits(channel);
  if (reply.length <= maxChars) return reply;
  return reply.slice(0, maxChars - 1).trimEnd() + '…';
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();
}

function visibleSafe(value: string): string {
  return value
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '<CPF protegido>')
    .replace(/\b\d{5}-?\d{3}\b/g, '<CEP protegido>');
}

function extractCpf(value: string): string | null {
  const match = value.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);
  return match ? match[0].replace(/\D/g, '') : null;
}

function hasCpf(value: string): boolean {
  // Só considera CPF se passar na validação de dígitos verificadores.
  // Telefone de 11 dígitos (ex: 48988326647) casa o regex mas falha no DV — não é CPF.
  // Formato pontuado (XXX.XXX.XXX-XX) é sempre tratado como CPF, mesmo se inválido,
  // porque a INTENÇÃO do usuário está clara — daí volta como ask_clarification.
  const match = value.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);
  if (!match) return false;
  const original = match[0];
  if (/[.\-]/.test(original)) return true;
  const digits = original.replace(/\D/g, '');
  return isValidCpf(digits);
}

function isValidCpf(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;

  const checkDigit = (factor: number) => {
    const total = digits
      .slice(0, factor - 1)
      .split('')
      .reduce((sum, digit, index) => sum + Number(digit) * (factor - index), 0);
    const mod = (total * 10) % 11;
    return mod === 10 ? 0 : mod;
  };

  return checkDigit(10) === Number(digits[9]) && checkDigit(11) === Number(digits[10]);
}

function extractZip(value: string): string | null {
  const match = value.match(/\b\d{5}-?\d{3}\b/);
  return match ? match[0].replace(/\D/g, '') : null;
}

function extractYear(value: string): string | null {
  const match = value.match(/\b(19[8-9]\d|20[0-3]\d)\b/);
  return match?.[0] ?? null;
}

function extractBirthDate(value: string): string | null {
  const br = value.match(/\b\d{2}\/\d{2}\/\d{4}\b/);
  if (br) return br[0];
  const iso = value.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  // Aceita DDMMAAAA cru (ex: "04031976" → "04/03/1976") — comum no WhatsApp.
  const cru = value.match(/\b(\d{2})(\d{2})(\d{4})\b/);
  if (cru) {
    const dd = Number(cru[1]);
    const mm = Number(cru[2]);
    const yyyy = Number(cru[3]);
    const thisYear = new Date().getFullYear();
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yyyy >= 1900 && yyyy <= thisYear - 14) {
      return `${cru[1]}/${cru[2]}/${cru[3]}`;
    }
  }
  return null;
}

function choiceFor(stepId: ActiveStepId, message: string): Choice | null {
  const choices = CHOICES[stepId] ?? [];
  const normalized = normalize(message);
  return choices.find((choice) => normalize(choice.value) === normalized || choice.terms.some((term) => normalized.includes(normalize(term)))) ?? null;
}

function isGenericVehicleModel(value: string): boolean {
  const normalized = normalize(value);
  const genericTerms = [
    'sedan',
    'hatch',
    'suv',
    'pickup',
    'picape',
    'carro',
    'veiculo',
    'veículo',
    'automatico',
    'automático',
    'manual',
    'flex',
    'gasolina',
    'alcool',
    'álcool',
    'hybrid',
    'hibrido',
    'híbrido',
  ];

  return normalized.length < 4 || genericTerms.includes(normalized) || /^\d(?:\.\d)?$/.test(normalized);
}

function asksForOptions(value: string): boolean {
  const normalized = normalize(value);
  return [
    'opcoes',
    'opções',
    'opcao',
    'opção',
    'lista',
    'listar',
    'apresenta',
    'apresente',
    'mostrar',
    'mostra',
    'nao sei',
    'não sei',
    'nao tenho certeza',
    'não tenho certeza',
    'me ajuda',
  ].some((term) => normalized.includes(normalize(term)));
}

function looksLikeQuestion(value: string): boolean {
  const normalized = normalize(value);
  if (value.includes('?')) return true;
  const interrogatives = [
    'qual',
    'quais',
    'quanto',
    'quantos',
    'quanta',
    'como',
    'por que',
    'porque',
    'pq',
    'o que',
    'oq',
    'vale a pena',
    'compensa',
    'devo',
    'posso',
    'preciso',
    'explica',
    'explique',
    'diferenca',
    'diferença',
    'duvida',
    'dúvida',
    'me ajuda',
    'me explica',
    'tipo de',
    'qual a',
    'qual o',
    'e se',
  ];
  return interrogatives.some((term) => normalized.includes(term));
}

function catalogPartialMatches(request: AssistantRequest): typeof request.catalogContext.items {
  const normalized = normalize(request.message);
  const terms = normalized
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !isGenericVehicleModel(term));

  return request.catalogContext.items.filter((item) => {
    const label = normalize(item.label);
    const id = normalize(item.id);
    if (label === normalized || id === normalized) return true;
    if (label.includes(normalized) || normalized.includes(label)) return true;
    return terms.length > 0 && terms.every((term) => label.includes(term));
  });
}

function catalogMatch(request: AssistantRequest): AssistantStepAnswer | null {
  const normalized = normalize(request.message);
  const items = request.catalogContext.items;
  const exact = items.find((item) => normalize(item.label) === normalized || normalize(item.id) === normalized);
  if (exact) {
    return {
      stepId: request.snapshot.stepId,
      value: exact.id,
      displayLabel: exact.label,
      metadata: exact.metadata,
      confidence: 0.95,
    };
  }

  if (request.snapshot.stepId === 'vehicle_model' && isGenericVehicleModel(request.message)) {
    return null;
  }

  const partialMatches = catalogPartialMatches(request);
  if (partialMatches.length !== 1) return null;
  const partial = partialMatches[0];
  if (!partial) return null;

  return {
    stepId: request.snapshot.stepId,
    value: partial.id,
    displayLabel: partial.label,
    metadata: partial.metadata,
    confidence: 0.78,
  };
}

function catalogOptionsReply(request: AssistantRequest): string | null {
  const matches = catalogPartialMatches(request);
  const source = matches.length > 0 ? matches : request.catalogContext.items;
  const options = source.slice(0, 6).map((item, index) => `${index + 1}. ${item.label}`);
  if (options.length === 0) return null;

  if (request.snapshot.stepId === 'vehicle_brand') {
    return `Encontrei estas marcas no catálogo: ${options.join(' | ')}. Qual delas devo usar?`;
  }

  return `Encontrei estas versões no catálogo: ${options.join(' | ')}. Me diga uma delas exatamente como aparece aqui.`;
}

function localAnswer(
  channel: Channel,
  stepId: ActiveStepId,
  value: string,
  displayLabel = '',
  confidence = 0.82,
): AssistantResponse {
  return {
    ok: true,
    source: 'local-rules',
    configured: configured(),
    mode: 'capture',
    action: 'answer_step',
    stepId,
    channel,
    reply: 'Perfeito, entendi.',
    proposedAnswer: {
      stepId,
      value,
      displayLabel: displayLabel || undefined,
      confidence,
    },
  };
}

function localAsk(channel: Channel, stepId: ActiveStepId, reply: string): AssistantResponse {
  return {
    ok: true,
    source: 'local-rules',
    configured: configured(),
    mode: 'capture',
    action: 'ask_clarification',
    stepId,
    channel,
    reply: truncateReply(reply, channel),
  };
}

function localRules(request: AssistantRequest): AssistantResponse {
  const stepId = request.snapshot.stepId;
  const channel = request.channel;
  const raw = request.message.trim();

  if (hasCpf(raw) && stepId !== 'document') {
    return localAsk(channel, stepId, 'Vou guardar esse CPF pra o final. Primeiro me confirma a pergunta atual.');
  }

  if (stepId === 'quote_link') {
    const intent = normalize(raw);
    if (/(sim|pode|calcula|calcular|manda|bora|gerar|ok)/.test(intent)) {
      return {
        ok: true,
        source: 'local-rules',
        configured: configured(),
        mode: 'capture',
        action: 'calculate',
        stepId,
        channel,
        reply: truncateReply('Fechado. Vou calcular agora.', channel),
      };
    }
  }

  if (stepId === 'vehicle_brand' || stepId === 'vehicle_model') {
    const matched = catalogMatch(request);
    if (matched) {
      return {
        ok: true,
        source: 'local-rules',
        configured: configured(),
        mode: 'capture',
        action: 'answer_step',
        stepId,
        channel,
        reply: truncateReply('Encontrei essa opção certinha.', channel),
        proposedAnswer: matched,
      };
    }
    const optionsReply = catalogOptionsReply(request);
    if (optionsReply && (stepId === 'vehicle_model' || asksForOptions(raw))) {
      return localAsk(channel, stepId, optionsReply);
    }
    return localAsk(
      channel,
      stepId,
      stepId === 'vehicle_model'
        ? 'Preciso da versão completa do modelo pra eu identificar a opção certa.'
        : 'Ainda preciso identificar essa opção com segurança. Pode escrever de outro jeito?',
    );
  }

  const choice = choiceFor(stepId, raw);
  if (choice) return localAnswer(channel, stepId, choice.value, choice.label, 0.86);

  if (stepId === 'name') {
    if (raw.split(/\s+/).filter(Boolean).length >= 2) return localAnswer(channel, stepId, raw, raw, 0.9);
    return localAsk(channel, stepId, 'Me manda nome e sobrenome pra eu seguir direitinho.');
  }
  if (stepId === 'vehicle_year') {
    const year = extractYear(raw);
    if (year) return localAnswer(channel, stepId, year, year, 0.9);
  }
  if (stepId === 'zip_code') {
    const zip = extractZip(raw);
    if (zip) return localAnswer(channel, stepId, zip, `${zip.slice(0, 5)}-${zip.slice(5)}`, 0.9);
  }
  if (stepId === 'contact') {
    if (/pular|nao|não|depois/i.test(raw)) return localAnswer(channel, stepId, '', 'Não informado agora', 0.82);
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 10) return localAnswer(channel, stepId, digits, '', 0.84);
  }
  if (stepId === 'driver_birth_date') {
    const date = extractBirthDate(raw);
    if (date) return localAnswer(channel, stepId, date, date, 0.9);
  }
  if (stepId === 'document') {
    const cpf = extractCpf(raw);
    if (cpf && isValidCpf(cpf)) return localAnswer(channel, stepId, cpf, '<CPF protegido>', 0.9);
    if (cpf) return localAsk(channel, stepId, 'Esse CPF não passou na validação. Pode conferir e me mandar de novo?');
  }

  return localAsk(channel, stepId, `Entendi: "${visibleSafe(raw)}". Pode responder essa etapa de forma um pouco mais direta?`);
}

function taskdunUrl(): string {
  return new URL(TASKDUN_AI_CHAT_PATH, TASKDUN_AI_BASE_URL).toString();
}

async function chatCompletion({
  model,
  messages,
  json = false,
  temperature,
}: {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  json?: boolean;
  temperature?: number;
}): Promise<string> {
  const payload = {
    model,
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    messages,
  };

  const response = await fetch(taskdunUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TASKDUN_AI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      detail = parsed.error?.message ? `: ${parsed.error.message.slice(0, 220)}` : '';
    } catch {
      detail = raw ? `: ${raw.slice(0, 220)}` : '';
    }
    throw new Error(`Taskdun AI HTTP ${response.status}${detail}`);
  }

  const body = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('Taskdun AI não retornou conteúdo.');
  return content;
}

function routerSystemPrompt(): string {
  return [
    'Você é o roteador de intenção do Robocote, corretor digital inteligente da Robocote/Taskdun.',
    'Sua função NÃO é falar com o cliente — é classificar a intenção do turno e extrair dado quando for o caso.',
    'Sempre retorne JSON válido. Nada de texto fora do JSON.',
    '',
    '## ORDEM DE DECISÃO (siga nesta ordem, pare na primeira que se aplicar)',
    '',
    '1. A mensagem é uma PERGUNTA sobre seguro, produto, cobertura, franquia, assistência, sinistro, preço, indenização, terceiros, comparação ou decisão?',
    '   - Sinais: termina em "?", começa com "o que é", "qual a diferença", "como funciona", "vale a pena", "por que", "me explica", "tenho uma dúvida", "antes de responder", "gostaria de saber".',
    '   - Pode estar DENTRO de uma frase mais longa. Se houver pergunta consultiva, ela vence.',
    '   - DECIDA: mode=consult, action=consult_reply, consultTopic=2-6 palavras sobre o tema. value="" displayLabel="".',
    '   - NÃO tente extrair dado do step atual nesse caso.',
    '',
    '2. A mensagem é resposta DIRETA da pergunta atual da jornada?',
    '   - Se houver allowedChoices e a mensagem bate com um value (case-insensitive, acentos toleráveis): action=answer_step, value=<value exato>.',
    '   - Se houver catalogOptions e a mensagem bate com um label/id (ou abreviação inequívoca): action=answer_step, value=<id exato>, displayLabel=<label>.',
    '   - Para texto livre (nome, ano, CEP, data, telefone): action=answer_step com o valor extraído.',
    '',
    '3. MEMÓRIA DE PISTAS — antes de pedir de novo, olhe `recentMessages` (últimas 3-5 falas do lead):',
    '   - Se o lead JÁ disse o que está sendo pedido agora (mesmo em turno anterior), use essa pista pra resolver o step atual.',
    '   - Exemplo: lead disse "Compass 2.0 Limited" quando perguntaram ano → no step vehicle_model, casar com catalogOptions e retornar answer_step.',
    '   - Se a pista casa com UMA opção do catálogo: action=answer_step com o id exato.',
    '   - Se casa com 2+ opções: action=ask_clarification listando as opções pra confirmação.',
    '   - **NUNCA peça de novo um dado que o lead já mencionou na recentMessages se você consegue resolvê-lo agora.**',
    '',
    '4. Se mensagem atual + pistas são insuficientes pra resolver o step (ex: "Civic" no step de ano sem pista de ano nas recentMessages; "sedan" no step de modelo):',
    '   - action=ask_clarification, value="".',
    '',
    '5. Se step=quote_link e mensagem confirma cálculo ("sim", "pode", "manda", "bora", "calcula"):',
    '   - action=calculate, value="".',
    '',
    '6. Caso contrário: action=none.',
    '',
    '## REGRAS PÉTREAS',
    '',
    '- Nunca peça CPF antes da etapa "document". Se vier CPF antes, action=ask_clarification.',
    '- Para vehicle_model, nunca escolha por termo genérico (sedan, hatch, suv, automático, flex, manual, gasolina, flex). Se ambíguo, action=ask_clarification.',
    '- Confidence entre 0 e 1: 0.9+ se tem certeza, 0.5-0.8 médio, abaixo de 0.5 quando incerto.',
    '',
    '## EXEMPLOS',
    '',
    'STEP=vehicle_brand, msg="antes gostaria de saber o que é franquia?"',
    '→ { "mode":"consult", "action":"consult_reply", "value":"", "displayLabel":"", "consultTopic":"definição de franquia", "confidence":0.95 }',
    '',
    'STEP=vehicle_brand, msg="Honda"',
    '→ { "mode":"capture", "action":"answer_step", "value":"<id_honda_do_catalogo>", "displayLabel":"Honda", "consultTopic":"", "confidence":0.92 }',
    '',
    'STEP=vehicle_year, msg="Civic"',
    '→ { "mode":"capture", "action":"ask_clarification", "value":"", "displayLabel":"", "consultTopic":"", "confidence":0.7 }',
    '',
    'STEP=vehicle_model, msg="qual mesmo?", recentMessages=["Compass 2.0 Limited","2024"], catalogOptions inclui {id:"abc-123", label:"COMPASS LIMITED TD 350 2.0 4x4 Die. Aut."}',
    '→ { "mode":"capture", "action":"answer_step", "value":"abc-123", "displayLabel":"COMPASS LIMITED TD 350 2.0 4x4 Die. Aut.", "consultTopic":"", "confidence":0.85 } (resolveu pela pista "Compass 2.0 Limited" anterior; reply vai confirmar com o lead antes de seguir)',
    '',
    'STEP=zip_code, msg="01311-000 mas qual a diferença entre compreensiva e terceiros?"',
    '→ { "mode":"consult", "action":"consult_reply", "value":"", "displayLabel":"", "consultTopic":"compreensiva vs terceiros", "confidence":0.95 }',
    '',
    'STEP=coverage, msg="quero economia"',
    '→ { "mode":"capture", "action":"answer_step", "value":"Economia", "displayLabel":"Economia", "consultTopic":"", "confidence":0.9 }',
    '',
    'JSON final: { "mode", "action", "value", "displayLabel", "consultTopic", "confidence" }',
  ].join('\n');
}

function routerUserPrompt(request: AssistantRequest): string {
  const currentStep = STEP_CONTEXT[request.snapshot.stepId];
  return JSON.stringify({
    channel: request.channel,
    currentStep: request.snapshot.stepId,
    currentStepTitle: currentStep.title,
    currentStepPrompt: currentStep.prompt,
    allowedChoices: (CHOICES[request.snapshot.stepId] ?? []).map((choice) => ({
      label: choice.label,
      value: choice.value,
    })),
    previousAnswers: Object.fromEntries(
      Object.entries(request.snapshot.answers).map(([key, value]) => [
        key,
        {
          value: value.value,
          hasRawValue: Boolean(value.rawValue),
          hasMetadata: Boolean(value.metadata),
        },
      ]),
    ),
    recentMessages: request.snapshot.recentMessages,
    catalogOptions: request.catalogContext.items.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
    })),
    userMessage: request.message,
  });
}

function summarizeAnswers(answers: AssistantRequest['snapshot']['answers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, answer] of Object.entries(answers)) {
    if (key === 'document' || key === 'contact') continue;
    out[key] = answer.value;
  }
  return out;
}

async function replySystemPrompt(channel: Channel, mode: AssistantMode): Promise<string> {
  const persona = await getRobocotePersona();
  const { maxChars, humanLabel } = channelLimits(channel);

  const modeBlock = mode === 'consult'
    ? [
        '## Turno atual: MODO CONSULTA',
        'O cliente fez uma pergunta sobre seguros/produto/decisão. Sua função agora:',
        '1. Responder a pergunta de forma consultiva, baseada no que você sabe de seguros.',
        '2. NÃO inventar números, preços, franquias ou regras de seguradora.',
        '3. Após responder, oferecer retomar a etapa atual da jornada de forma natural.',
        '4. Se a pergunta exige número específico que só a cotação tem, diga que o número exato vem do cálculo.',
      ].join('\n')
    : [
        '## Turno atual: MODO CAPTURA',
        'O sistema já extraiu (ou tentou extrair) a resposta da etapa atual. Sua função:',
        '1. Gerar UMA frase curta confirmando o que entendeu (action=answer_step) ou pedindo esclarecimento (action=ask_clarification).',
        '2. NÃO faça a próxima pergunta. O sistema fará isso depois.',
        '3. Em answer_step, não repita dados sensíveis completos.',
        '',
        '### Pista anterior (usedRecentHint=true)',
        'Se o JSON do turno trouxer `routerDecision.usedRecentHint=true`, significa que você resolveu o step usando algo que o cliente já tinha dito ANTES (em recentMessages), não na mensagem atual.',
        'Nesse caso, a reply deve ser **confirmação ativa**, não declaração:',
        '- Anote o que entendeu citando o valor extraído.',
        '- Sinalize que se não for esse, o cliente pode corrigir.',
        '- Use verbos-âncora: "Ótimo", "Pelo que você me passou antes", "Confere comigo".',
        '- Exemplo: "Ótimo — pelo que você me passou antes, anotei o COMPASS LIMITED TD 350 2.0 4x4 Die. Aut. Se não for esse, me corrige."',
        '- Demonstra memória de corretora atenta. É prova de inteligência.',
      ].join('\n');

  return [
    persona,
    '',
    '---',
    '',
    `## Canal atual: ${humanLabel.toUpperCase()}`,
    `Sua resposta DEVE caber em ${maxChars} caracteres. Conte com sobra. Uma mensagem só.`,
    channel === 'whatsapp'
      ? 'WhatsApp: sem botões, sem listas longas, sem markdown pesado. Frase humana, direta.'
      : 'Webchat: pode usar marcadores leves se ajudar, mas mantenha curto.',
    '',
    modeBlock,
    '',
    '---',
    '',
    'Sua saída: JSON válido { "reply": "<sua mensagem como Robocote>" }. Nada fora do JSON.',
  ].join('\n');
}

/**
 * Decide se o `value` proposto veio MESMO da pista anterior (não da mensagem atual).
 *
 * Compara fonéticamente a mensagem atual com `displayLabel`/`value` proposto:
 *   - Se houver overlap claro (containment, igualdade, prefixo), considera que veio da mensagem.
 *   - Se NÃO houver overlap, a info veio de turno anterior — `usedRecentHint = true`.
 *
 * Isso evita a Robocotedizer "pelo que você me passou antes" quando o lead acabou
 * de dizer "Jeep" no step de marca.
 */
function messageMatchesProposed(message: string, proposed: AssistantStepAnswer): boolean {
  const m = normalize(message);
  if (!m) return false;
  const candidates = [proposed.displayLabel, proposed.value].filter((v): v is string => Boolean(v));
  for (const c of candidates) {
    const n = normalize(c);
    if (!n) continue;
    if (m === n) return true;
    if (m.includes(n) || n.includes(m)) return true;
    // Primeira palavra do proposto bate com algo na mensagem?
    const firstWord = n.split(/\s+/)[0];
    if (firstWord && firstWord.length >= 3 && m.includes(firstWord)) return true;
    // Última palavra do proposto bate? (ex: "compass limited" do lead vs "COMPASS LIMITED TD 350" proposto)
    const words = n.split(/\s+/).filter((w) => w.length >= 3);
    const overlap = words.filter((w) => m.includes(w)).length;
    if (overlap >= 2) return true;
  }
  return false;
}

function computeUsedRecentHint(
  request: AssistantRequest,
  proposedAnswer?: AssistantStepAnswer,
): boolean {
  if (!proposedAnswer) return false;
  if (request.snapshot.recentMessages.length === 0) return false;
  // Se a mensagem atual já contém ou casa com o proposto, NÃO é hint.
  if (messageMatchesProposed(request.message, proposedAnswer)) return false;
  return true;
}

function replyUserPrompt(
  request: AssistantRequest,
  router: RouterResponse,
  proposedAnswer?: AssistantStepAnswer,
  usedHint = false,
): string {
  const currentStep = STEP_CONTEXT[request.snapshot.stepId];
  return JSON.stringify({
    channel: request.channel,
    currentStep: request.snapshot.stepId,
    currentStepTitle: currentStep.title,
    currentStepPrompt: currentStep.prompt,
    routerDecision: {
      mode: router.mode,
      action: router.action,
      consultTopic: router.consultTopic || undefined,
      usedRecentHint: usedHint,
    },
    extractedValue: proposedAnswer?.displayLabel ?? proposedAnswer?.value ?? (router.value || undefined),
    userMessage: visibleSafe(request.message),
    recentMessages: request.snapshot.recentMessages,
    previousAnswersSummary: summarizeAnswers(request.snapshot.answers),
  });
}

function needsAnalystModel(request: AssistantRequest, router: RouterResponse): boolean {
  if (router.mode === 'consult') return true;
  if (request.snapshot.stepId === 'coverage') return true;
  if (router.action === 'ask_clarification') return true;
  if (request.message.length > 180) return true;

  const message = normalize(request.message);
  const complexTerms = [
    'franquia',
    'cobertura',
    'assistencia',
    'assistência',
    'seguradora',
    'sinistro',
    'indenizacao',
    'indenização',
    'roubo',
    'furto',
    'terceiros',
    'danos',
    'fipe',
    'parcelamento',
    'parcelar',
    'recomenda',
    'recomendacao',
    'recomendação',
    'melhor',
    'comparar',
    'comparacao',
    'comparação',
    'duvida',
    'dúvida',
    'explica',
    'diferença',
    'diferenca',
    'vale a pena',
    'compensa',
  ];
  return complexTerms.some((term) => message.includes(normalize(term)));
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const match = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (match) return JSON.parse(match[1]);
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) return JSON.parse(objectMatch[0]);
  throw new Error('Taskdun AI não retornou JSON.');
}

function proposedAnswerFromRouter(
  request: AssistantRequest,
  router: RouterResponse,
): AssistantStepAnswer | undefined {
  if (router.action !== 'answer_step' || !router.value) return undefined;

  const stepId = request.snapshot.stepId;

  if (stepId === 'vehicle_year') {
    const year = extractYear(request.message);
    if (!year || router.value !== year) return undefined;
    return { stepId, value: year, displayLabel: year, confidence: router.confidence };
  }

  if (stepId === 'driver_birth_date') {
    const date = extractBirthDate(request.message);
    if (!date) return undefined;
    return { stepId, value: date, displayLabel: date, confidence: router.confidence };
  }

  if (stepId === 'zip_code') {
    const zip = extractZip(request.message);
    if (!zip || router.value.replace(/\D/g, '') !== zip) return undefined;
    return {
      stepId,
      value: zip,
      displayLabel: `${zip.slice(0, 5)}-${zip.slice(5)}`,
      confidence: router.confidence,
    };
  }

  if (stepId === 'vehicle_brand' || stepId === 'vehicle_model') {
    const catalog = request.catalogContext.items.find((item) => item.id === router.value);
    if (!catalog) return undefined;
    return {
      stepId,
      value: router.value,
      displayLabel: router.displayLabel || catalog.label,
      metadata: catalog.metadata,
      confidence: router.confidence,
    };
  }

  const choices = CHOICES[stepId];
  if (choices?.length) {
    const choice = choices.find((item) => item.value === router.value);
    if (!choice) return undefined;
    return {
      stepId,
      value: choice.value,
      displayLabel: router.displayLabel || choice.label,
      confidence: router.confidence,
    };
  }

  return {
    stepId,
    value: router.value,
    displayLabel: router.displayLabel || undefined,
    confidence: router.confidence,
  };
}

async function taskdunAi(request: AssistantRequest): Promise<AssistantResponse | null> {
  if (!configured()) return null;

  const routerContent = await chatCompletion({
    model: ROBOCOTE_EXTRACTOR_MODEL,
    json: true,
    temperature: 0.1,
    messages: [
      { role: 'system', content: routerSystemPrompt() },
      { role: 'user', content: routerUserPrompt(request) },
    ],
  });

  const router = routerResponseSchema.parse(parseJsonContent(routerContent));
  const stepId = request.snapshot.stepId;

  if (process.env.ROBOCOTE_DEBUG_ROUTER === '1') {
    console.log(`[router] step=${stepId} channel=${request.channel} mode=${router.mode} action=${router.action} value="${router.value}" topic="${router.consultTopic}" conf=${router.confidence}`);
  }

  if (router.action === 'calculate' && stepId !== 'quote_link') return null;
  if (router.action === 'consult_reply') router.mode = 'consult';
  if (router.mode === 'consult' && router.action === 'answer_step') {
    // contradição do modelo — força consult_reply
    router.action = 'consult_reply';
  }

  const proposedAnswer = router.action === 'answer_step' ? proposedAnswerFromRouter(request, router) : undefined;
  // Se o router disse answer_step mas o valor não validou (catálogo, choice, etc),
  // não derruba pra local — vira ask_clarification e a Robocotepede esclarecimento como humana.
  if (router.action === 'answer_step' && !proposedAnswer) {
    router.action = 'ask_clarification';
  }

  const usedHint = router.action === 'answer_step' && computeUsedRecentHint(request, proposedAnswer);

  const replyModel = needsAnalystModel(request, router) ? ROBOCOTE_ANALYST_MODEL : ROBOCOTE_DIALOG_MODEL;
  let reply: string;

  try {
    // GPT-5.3 / GPT-5.4 (família nova) rejeitam `temperature` custom — só aceitam o default.
    // Por isso aqui NÃO passamos temperature. O tom já é segurado pelo Personality Core.
    const replyContent = await chatCompletion({
      model: replyModel,
      json: true,
      messages: [
        { role: 'system', content: await replySystemPrompt(request.channel, router.mode) },
        { role: 'user', content: replyUserPrompt(request, router, proposedAnswer, usedHint) },
      ],
    });
    reply = replyResponseSchema.parse(parseJsonContent(replyContent)).reply;
  } catch (e) {
    console.warn(`Reply model indisponível; fallback de reply: ${(e as Error).message}`);
    reply = router.mode === 'consult'
      ? 'Boa pergunta — vou te explicar daqui a pouco. Por enquanto, voltando à pergunta atual.'
      : 'Perfeito, entendi.';
  }

  return {
    ok: true,
    source: 'taskdun-ai',
    configured: true,
    mode: router.mode,
    action: router.action,
    stepId,
    channel: request.channel,
    reply: truncateReply(reply, request.channel),
    proposedAnswer,
    pendingConfirmation: Boolean(usedHint),
  };
}

export function parseAssistantRequest(value: unknown): AssistantRequest {
  return assistantRequestSchema.parse(value);
}

export function getAssistantModelConfig(): {
  configured: boolean;
  dialogModel: string;
  complexDialogModel: string;
  extractorModel: string;
  analystModel: string;
  chatPath: string;
} {
  return {
    configured: configured(),
    dialogModel: ROBOCOTE_DIALOG_MODEL,
    complexDialogModel: ROBOCOTE_ANALYST_MODEL,
    extractorModel: ROBOCOTE_EXTRACTOR_MODEL,
    analystModel: ROBOCOTE_ANALYST_MODEL,
    chatPath: TASKDUN_AI_CHAT_PATH,
  };
}

function mustStayLocal(request: AssistantRequest): boolean {
  // Só o CPF (step document) e CPF na mensagem fora do step ficam blindados em regra local.
  // Catálogo (brand/year/model) agora vai à IA: a validação server-side em proposedAnswerFromRouter
  // garante que só ids reais entram, e a Robocotepode soar humana nesses turnos.
  return request.snapshot.stepId === 'document' || hasCpf(request.message);
}

async function enrichWithServerCatalog(request: AssistantRequest): Promise<AssistantRequest> {
  // Se o caller (frontend webchat) já mandou catálogo, respeita.
  // Se veio vazio E o step exige catálogo (WhatsApp ou client minimalista), carrega server-side.
  if (request.catalogContext.items.length > 0) return request;
  if (!stepNeedsCatalog(request.snapshot.stepId)) return request;

  try {
    const items = await loadCatalogForStep(request.snapshot.stepId, request.snapshot.answers);
    if (items.length === 0) return request;
    return {
      ...request,
      catalogContext: { items: items.slice(0, 200) },
    };
  } catch (e) {
    console.warn(`Falha ao carregar catálogo server-side para ${request.snapshot.stepId}: ${(e as Error).message}`);
    return request;
  }
}

export async function handleAutoF1AssistantMessage(request: AssistantRequest): Promise<AssistantResponse> {
  if (mustStayLocal(request) && !looksLikeQuestion(request.message)) {
    return localRules(request);
  }

  const enriched = await enrichWithServerCatalog(request);

  try {
    const ai = await taskdunAi(enriched);
    if (ai) return ai;
  } catch (e) {
    console.warn(`Taskdun AI indisponível; fallback local: ${(e as Error).message}`);
  }
  return localRules(enriched);
}
