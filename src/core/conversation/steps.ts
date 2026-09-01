/**
 * A jornada — quais perguntas existem, em que ordem, quais são puladas e como
 * uma resposta aceita move o lead adiante.
 *
 * Puro e sem canal: é a mesma jornada no WhatsApp e no webchat. Extraído do
 * orquestrador na Fase 3, sem mudar comportamento.
 *
 * NOTA (Fase 1 do plano, ainda pendente): esta ainda NÃO é a tabela única de
 * perguntas — existem cópias em session/store.ts, assistant/autoF1.ts e no
 * contrato HTTP. Consolidar aqui é o próximo passo.
 */

import type { SessionState } from '../../session/store.js';
import type { VehicleRamo } from '../../tenant/quoteConfig.js';
import { extractFirstName } from './language.js';

export /** Rótulos PT-BR dos ramos vehicle pra menu de seleção e confirmações. */
const RAMO_LABELS: Record<VehicleRamo, string> = {
  auto: 'Seguro de Carro',
  moto: 'Seguro de Moto',
  caminhao: 'Seguro de Caminhão',
};

/** Lê o ramo cravado na sessão (answer insurance_branch); sem escolha = auto. */
export function ramoFromAnswers(answers: Record<string, { rawValue?: string; value?: string }> = {}): VehicleRamo {
  const raw = answers.insurance_branch?.rawValue;
  return raw === 'moto' || raw === 'caminhao' ? raw : 'auto';
}

/**
 * Ajusta o texto de uma pergunta pro ramo escolhido.
 *
 * A tabela STEP_PROMPT é escrita em auto ("o carro") e fica INTOCADA — os testes
 * de caracterização congelam esses textos. Moto e caminhão entram por troca de
 * locução completa, com artigo junto: "o carro"→"a moto", nunca um replace cego
 * de palavra que produziria "o moto". Quem fala de caminhão dizendo "carro"
 * queima a confiança na primeira frase — wording é produto.
 */
const RAMO_WORDING: Record<Exclude<VehicleRamo, 'auto'>, Array<[string, string]>> = {
  moto: [
    ['esse carro', 'essa moto'],
    ['o carro', 'a moto'],
    ['do carro', 'da moto'],
  ],
  caminhao: [
    ['esse carro', 'esse caminhão'],
    ['o carro', 'o caminhão'],
    ['do carro', 'do caminhão'],
  ],
};

export function applyRamoWording(text: string, ramo: VehicleRamo): string {
  if (ramo === 'auto') return text;
  let out = text;
  for (const [de, para] of RAMO_WORDING[ramo]) {
    out = out.split(de).join(para);
  }
  return out;
}

export const STEP_ORDER = [
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

export type StepId = (typeof STEP_ORDER)[number];

export /** Pergunta padrão da Robocotepra cada step — usado quando avançamos via confirmação direta. */
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
  // TODO: hoje o step `contact` é obrigatório. Quando implementar skip real, restaurar "(pode pular se quiser)".
  contact: 'Qual WhatsApp o corretor pode usar pra continuar?',
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

export /**
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

export function nextStepAfter(stepId: StepId, answers: Record<string, { rawValue?: string; value?: string }> = {}): SessionState['stepId'] {
  const idx = STEP_ORDER.indexOf(stepId);
  if (idx === -1 || idx >= STEP_ORDER.length - 1) return 'complete';
  for (let i = idx + 1; i < STEP_ORDER.length; i += 1) {
    const candidate = STEP_ORDER[i];
    if (!shouldSkipStep(candidate, answers)) return candidate;
  }
  return 'complete';
}

export function normalizeCoverage(value: string): SessionState['coveragePreference'] {
  const v = value.trim().toLowerCase();
  if (v.includes('economia')) return 'Economia';
  if (v.includes('equilib') || v.includes('equilíb')) return 'Equilíbrio';
  if (v.includes('prote')) return 'Proteção';
  return null;
}

export /**
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

export /** Crava o ramo escolhido como answer e move a sessão pro 1º step da jornada (name). */
function setBranchAndStartJourney(session: SessionState, ramo: VehicleRamo): SessionState {
  return {
    ...session,
    stepId: 'name',
    answers: {
      ...session.answers,
      insurance_branch: {
        id: 'insurance_branch',
        label: 'Ramo',
        value: RAMO_LABELS[ramo],
        rawValue: ramo,
      },
    },
  };
}
