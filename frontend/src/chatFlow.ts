export type FlowStepId =
  | 'name'
  | 'mode'
  | 'vehicle_brand'
  | 'vehicle_year'
  | 'vehicle_model'
  | 'usage'
  | 'renewal_status'
  | 'zip_code'
  | 'residence_type'
  | 'residence_garage'
  | 'marital_status'
  | 'coverage'
  | 'contact'
  | 'driver_birth_date'
  | 'driver_sex'
  | 'document'
  | 'quote_link'
  | 'complete';
export type ActiveFlowStepId = Exclude<FlowStepId, 'complete'>;

export interface FlowAnswer {
  id: FlowStepId;
  label: string;
  value: string;
  rawValue?: string;
  /** Dados extras pro payload (ex: fipe_code, fipe_value do modelo selecionado). */
  metadata?: Record<string, unknown>;
}

export interface FlowChoice {
  label: string;
  value: string;
  description: string;
}

export interface FlowStep {
  id: ActiveFlowStepId;
  title: string;
  prompt: string;
  helper: string;
  inputMode: 'text' | 'choice' | 'action' | 'autocomplete' | 'dynamic_choice';
  placeholder?: string;
  choices?: FlowChoice[];
  required: boolean;
  /** Lista de steps anteriores cujas respostas precisam corresponder pra esse step aparecer. */
  conditions?: Array<{ stepId: FlowStepId; equals?: string; notEquals?: string }>;
  /** Fonte dinâmica (carregada via API): 'brands' ou 'models'. Usado por dynamic_choice/autocomplete. */
  dynamicSource?: 'brands' | 'models';
}

export interface ChatMessage {
  id: string;
  author: 'bot' | 'user' | 'system';
  text: string;
}

export interface FlowSnapshot {
  stepId: FlowStepId;
  answers: Partial<Record<FlowStepId, FlowAnswer>>;
  completed: boolean;
}

export const REAL_MODE_VALUE = 'real';

export const FLOW_ORDER: ActiveFlowStepId[] = [
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
];

export const FLOW_STEPS: Record<ActiveFlowStepId, FlowStep> = {
  name: {
    id: 'name',
    title: 'Nome',
    prompt: 'Qual é seu nome completo?',
    helper: 'Começamos pelo nome completo para evitar rejeição da seguradora. CPF só entra no fim do fluxo.',
    inputMode: 'text',
    placeholder: 'Digite nome e sobrenome',
    required: true,
  },
  mode: {
    id: 'mode',
    title: 'Modo técnico',
    prompt: 'Este modo técnico fica fora da conversa principal.',
    helper: 'A conversa padrão sempre coleta o veículo real do cliente.',
    inputMode: 'choice',
    required: true,
    choices: [
      {
        label: 'Jornada real',
        value: REAL_MODE_VALUE,
        description: 'Coleta marca, ano e modelo como o lead real responderia.',
      },
    ],
  },
  vehicle_brand: {
    id: 'vehicle_brand',
    title: 'Marca',
    prompt: 'Qual é a marca do veículo?',
    helper: 'Vou cruzar sua resposta com o catálogo oficial para evitar erro de modelo.',
    inputMode: 'autocomplete',
    placeholder: 'Digite a marca (ex: Honda)',
    required: true,
    dynamicSource: 'brands',
  },
  vehicle_year: {
    id: 'vehicle_year',
    title: 'Ano',
    prompt: 'Qual o ano do veículo?',
    helper: 'Use o ano que consta no documento (ex: 2020, 2024). As versões disponíveis serão filtradas pela marca + ano.',
    inputMode: 'text',
    placeholder: 'AAAA',
    required: true,
  },
  vehicle_model: {
    id: 'vehicle_model',
    title: 'Modelo',
    prompt: 'Qual é o modelo do veículo?',
    helper: 'Quanto mais específico for o modelo, mais precisa fica a cotação.',
    inputMode: 'autocomplete',
    placeholder: 'Ex: Corolla XEi, Onix LT, HB20 Comfort',
    required: true,
    dynamicSource: 'models',
  },
  usage: {
    id: 'usage',
    title: 'Uso',
    prompt: 'Qual é o uso principal do veículo?',
    helper: 'Quero entender a rotina do carro para montar uma cotação coerente.',
    inputMode: 'choice',
    required: true,
    choices: [
      { label: 'Uso pessoal', value: 'Uso pessoal', description: 'Rotina familiar, deslocamentos e lazer.' },
      { label: 'Trabalho/visitas', value: 'Trabalho/visitas', description: 'Uso misto com compromissos profissionais.' },
      { label: 'Empresa/frota', value: 'Empresa/frota', description: 'Caminho futuro para PJ e múltiplos veículos.' },
    ],
  },
  renewal_status: {
    id: 'renewal_status',
    title: 'Renovação?',
    prompt: 'É um seguro novo ou renovação de apólice atual?',
    helper: 'Isso ajuda a separar uma primeira cotação de uma troca ou renovação.',
    inputMode: 'choice',
    required: true,
    choices: [
      { label: 'Seguro novo', value: 'new', description: 'Primeira cotação ou trocando depois de um período sem seguro.' },
      { label: 'Renovação', value: 'renewal', description: 'Tem apólice ativa ou recém-vencida.' },
    ],
  },
  zip_code: {
    id: 'zip_code',
    title: 'CEP',
    prompt: 'Qual é o seu CEP de residência?',
    helper: 'O CEP é um dos campos que mais afeta o preço final — região define risco.',
    inputMode: 'text',
    placeholder: '00000-000',
    required: true,
  },
  residence_type: {
    id: 'residence_type',
    title: 'Residência',
    prompt: 'Você mora em casa ou apartamento?',
    helper: 'Tipo de residência entra no questionário de risco da seguradora.',
    inputMode: 'choice',
    required: true,
    choices: [
      { label: 'Casa', value: 'house', description: 'Residência térrea ou sobrado.' },
      { label: 'Apartamento', value: 'apartment', description: 'Unidade em condomínio.' },
    ],
  },
  residence_garage: {
    id: 'residence_garage',
    title: 'Garagem',
    prompt: 'Tem garagem na sua residência?',
    helper: 'A forma como o carro fica guardado pode influenciar o cálculo.',
    inputMode: 'choice',
    required: true,
    choices: [
      { label: 'Sim, com portão eletrônico', value: 'yes_with_electronic_gate', description: 'Garagem coberta + portão automatizado.' },
      { label: 'Sim, sem portão eletrônico', value: 'yes_no_electronic_gate', description: 'Garagem coberta mas sem automação.' },
      { label: 'Não tenho', value: 'no_garage', description: 'Estaciona na rua ou descoberto.' },
    ],
  },
  marital_status: {
    id: 'marital_status',
    title: 'Estado civil',
    prompt: 'Qual é o seu estado civil?',
    helper: 'Estado civil entra no payload do condutor principal.',
    inputMode: 'choice',
    required: true,
    choices: [
      { label: 'Solteiro(a)', value: 'single', description: 'Sem união estável.' },
      { label: 'Casado(a)', value: 'married', description: 'Inclui união estável.' },
      { label: 'Divorciado(a)', value: 'divorced', description: 'Divorciado ou separado judicialmente.' },
      { label: 'Viúvo(a)', value: 'widowed', description: 'Viúvo(a).' },
    ],
  },
  coverage: {
    id: 'coverage',
    title: 'Perfil',
    prompt: 'Na decisão, você quer priorizar economia, equilíbrio ou proteção?',
    helper: 'Isso define como o Robocote apresenta as opções ao cliente (não vai ao payload Segfy).',
    inputMode: 'choice',
    required: true,
    choices: [
      { label: 'Economia', value: 'Economia', description: 'Começa pelo menor preço e explica as limitações.' },
      { label: 'Equilíbrio', value: 'Equilíbrio', description: 'Preço competitivo com cobertura mais segura.' },
      { label: 'Proteção', value: 'Proteção', description: 'Valoriza assistência, franquia e amplitude da cobertura.' },
    ],
  },
  contact: {
    id: 'contact',
    title: 'Contato',
    prompt: 'Qual WhatsApp o corretor pode usar para continuar?',
    helper: 'Nesta versão, o dado fica só na tela para simular a experiência.',
    inputMode: 'text',
    placeholder: '(11) 99999-9999 ou pular',
    required: false,
  },
  driver_birth_date: {
    id: 'driver_birth_date',
    title: 'Nascimento',
    prompt: 'Agora os dados finais para calcular: qual é a data de nascimento do condutor?',
    helper: 'Agora faltam só os dados finais para calcular com segurança.',
    inputMode: 'text',
    placeholder: 'DD/MM/AAAA',
    required: true,
  },
  driver_sex: {
    id: 'driver_sex',
    title: 'Sexo',
    prompt: 'Qual sexo consta no cadastro do condutor?',
    helper: 'Essa informação é usada no cadastro do condutor principal.',
    inputMode: 'choice',
    required: true,
    choices: [
      { label: 'Masculino', value: 'male', description: 'Usa male no contrato da Nova Jornada.' },
      { label: 'Feminino', value: 'female', description: 'Usa female no contrato da Nova Jornada.' },
    ],
  },
  document: {
    id: 'document',
    title: 'CPF',
    prompt: 'Por fim, qual CPF devemos usar para disparar a cotação oficial?',
    helper: 'O CPF fica para o final e aparece protegido na interface.',
    inputMode: 'text',
    placeholder: '000.000.000-00',
    required: true,
  },
  quote_link: {
    id: 'quote_link',
    title: 'Link',
    prompt: 'Pronto. Posso calcular agora e gerar sua página de comparação?',
    helper: 'A cotação será organizada em uma página clara para comparar as opções.',
    inputMode: 'action',
    required: true,
  },
};

export const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'm-start-1',
    author: 'bot',
    text: 'Olá, eu sou a Vivi da Robocote. Vou te ajudar a cotar seu seguro auto.',
  },
  {
    id: 'm-start-2',
    author: 'bot',
    text: 'Pode responder do seu jeito. Eu entendo, organizo os dados e deixo CPF só para o final.',
  },
  {
    id: 'm-start-3',
    author: 'bot',
    text: FLOW_STEPS.name.prompt,
  },
];

function stepMatchesConditions(
  step: FlowStep,
  answers: Partial<Record<FlowStepId, FlowAnswer>>,
): boolean {
  if (!step.conditions || step.conditions.length === 0) return true;
  return step.conditions.every((cond) => {
    const ans = answers[cond.stepId];
    const raw = ans?.rawValue ?? ans?.value;
    if (cond.equals !== undefined) return raw === cond.equals;
    if (cond.notEquals !== undefined) return raw !== cond.notEquals;
    return true;
  });
}

export function getNextStepId(
  stepId: ActiveFlowStepId,
  answers: Partial<Record<FlowStepId, FlowAnswer>>,
): FlowStepId {
  const startIndex = FLOW_ORDER.indexOf(stepId);
  if (startIndex === -1) return 'complete';
  for (let i = startIndex + 1; i < FLOW_ORDER.length; i += 1) {
    const candidate = FLOW_ORDER[i];
    if (stepMatchesConditions(FLOW_STEPS[candidate], answers)) {
      return candidate;
    }
  }
  return 'complete';
}

export function validateStepValue(step: FlowStep, value: string): string | null {
  const normalized = value.trim();
  if (step.required && normalized.length === 0) {
    return 'Preciso dessa informação para seguir.';
  }
  if (step.inputMode === 'autocomplete' && step.required && normalized.length === 0) {
    return 'Escolha uma das opções da lista.';
  }
  if (step.id === 'name' && normalized.split(/\s+/).filter(Boolean).length < 2) {
    return 'Preciso de nome e sobrenome para calcular corretamente.';
  }
  if (step.id === 'contact' && normalized.length > 0 && normalized.replace(/\D/g, '').length < 10) {
    return 'Esse WhatsApp parece curto. Você pode corrigir ou pular por enquanto.';
  }
  if (step.id === 'zip_code') {
    const digits = normalized.replace(/\D/g, '');
    if (digits.length !== 8) return 'O CEP precisa ter 8 dígitos (ex: 01311-000).';
  }
  if (step.id === 'vehicle_year') {
    const year = Number(normalized);
    if (!Number.isInteger(year) || year < 1980 || year > new Date().getFullYear() + 1) {
      return 'Use um ano válido (entre 1980 e o ano atual + 1).';
    }
  }
  if (step.id === 'driver_birth_date' && !normalizeBirthDate(normalized)) {
    return 'Use a data no formato DD/MM/AAAA.';
  }
  if (step.id === 'document' && !isValidCpf(normalized)) {
    return 'Esse CPF não passou na validação. Confira os números antes de calcular.';
  }
  return null;
}

export function buildAnswer(
  step: FlowStep,
  value: string,
  options: { displayLabel?: string; metadata?: Record<string, unknown> } = {},
): FlowAnswer {
  const normalized = value.trim();
  const choice = step.choices?.find((item) => item.value === normalized);
  if (step.id === 'contact') {
    return {
      id: step.id,
      label: step.title,
      value: maskPhone(normalized),
      rawValue: normalized.replace(/\D/g, ''),
    };
  }
  if (step.id === 'driver_birth_date') {
    const iso = normalizeBirthDate(normalized) ?? normalized;
    return {
      id: step.id,
      label: step.title,
      value: formatBirthDate(iso),
      rawValue: iso,
    };
  }
  if (step.id === 'document') {
    const digits = normalized.replace(/\D/g, '');
    return {
      id: step.id,
      label: step.title,
      value: maskCpf(digits),
      rawValue: digits,
    };
  }
  if (step.id === 'zip_code') {
    const digits = normalized.replace(/\D/g, '');
    const masked = digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
    return {
      id: step.id,
      label: step.title,
      value: masked,
      rawValue: digits,
    };
  }
  // Autocomplete (marca, modelo) ou dynamic_choice: o componente passa displayLabel
  // (texto humano) + metadata (fipe_code, fipe_value, model_id, etc).
  if (step.inputMode === 'autocomplete' || step.inputMode === 'dynamic_choice') {
    return {
      id: step.id,
      label: step.title,
      value: options.displayLabel ?? (normalized || 'Não informado agora'),
      rawValue: normalized,
      metadata: options.metadata,
    };
  }
  return {
    id: step.id,
    label: step.title,
    value: options.displayLabel ?? choice?.label ?? (normalized || 'Não informado agora'),
    rawValue: choice?.value ?? normalized,
    metadata: options.metadata,
  };
}

export function buildBotFollowUp(nextStepId: FlowStepId): ChatMessage[] {
  if (nextStepId === 'complete') {
    return [
      {
        id: `m-${Date.now()}-complete-1`,
        author: 'bot',
        text: 'Perfeito. Montei o caminho seguro e já posso entregar o link consultivo da cotação.',
      },
      {
        id: `m-${Date.now()}-complete-2`,
        author: 'bot',
        text: 'A partir daqui eu posso explicar as opções usando estes mesmos dados e regras de segurança.',
      },
    ];
  }

  const nextStep = FLOW_STEPS[nextStepId];
  return [
    {
      id: `m-${Date.now()}-${nextStepId}-prompt`,
      author: 'bot',
      text: nextStep.prompt,
    },
  ];
}

export function buildWhatsappPreview(answers: Partial<Record<FlowStepId, FlowAnswer>>, quoteUrl: string): string {
  const name = answers.name?.value || 'Tudo certo';
  const profile = answers.coverage?.value || 'Equilíbrio';
  return `Olá, ${name}! Separei uma cotação auto com foco em ${profile.toLowerCase()}. Veja as opções recomendadas aqui: ${quoteUrl}`;
}

export function answerPayloadValue(answer: FlowAnswer | undefined): string {
  return answer?.rawValue ?? answer?.value ?? '';
}

/** Retorna os steps visíveis dado o estado atual de respostas — útil pra progress bar e flow rail. */
export function getVisibleSteps(
  answers: Partial<Record<FlowStepId, FlowAnswer>>,
): ActiveFlowStepId[] {
  return FLOW_ORDER.filter((id) => stepMatchesConditions(FLOW_STEPS[id], answers));
}

function normalizeBirthDate(value: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return isRealDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? value : null;

  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!br) return null;

  const day = Number(br[1]);
  const month = Number(br[2]);
  const year = Number(br[3]);
  if (!isRealDate(year, month, day)) return null;
  return `${br[3]}-${br[2]}-${br[1]}`;
}

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatBirthDate(value: string): string {
  const iso = normalizeBirthDate(value);
  if (!iso) return value;
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function maskCpf(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11) return '<CPF protegido>';
  return `${digits.slice(0, 3)}.***.***-${digits.slice(9)}`;
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (!digits) return 'Não informado agora';
  if (digits.length < 4) return '<telefone protegido>';
  return `(**) *****-${digits.slice(-4)}`;
}

function isValidCpf(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;

  const numbers = digits.split('').map(Number);
  const firstDigit = calculateCpfDigit(numbers.slice(0, 9), 10);
  const secondDigit = calculateCpfDigit([...numbers.slice(0, 9), firstDigit], 11);
  return firstDigit === numbers[9] && secondDigit === numbers[10];
}

function calculateCpfDigit(numbers: number[], weightStart: number): number {
  const sum = numbers.reduce((total, digit, index) => total + digit * (weightStart - index), 0);
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}
