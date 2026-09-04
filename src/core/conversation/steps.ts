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

/** Ramos que já têm jornada conversacional. Residencial roda no motor Segfy `residence`. */
export type JourneyRamo = VehicleRamo | 'residencial';

export /** Rótulos PT-BR dos ramos com jornada pra menu de seleção e confirmações. */
const RAMO_LABELS: Record<JourneyRamo, string> = {
  auto: 'Seguro de Carro',
  moto: 'Seguro de Moto',
  caminhao: 'Seguro de Caminhão',
  residencial: 'Seguro Residencial',
};

/** Lê o ramo cravado na sessão (answer insurance_branch); sem escolha = auto. */
export function ramoFromAnswers(answers: Record<string, { rawValue?: string; value?: string }> = {}): JourneyRamo {
  const raw = answers.insurance_branch?.rawValue;
  return raw === 'moto' || raw === 'caminhao' || raw === 'residencial' ? raw : 'auto';
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

export function applyRamoWording(text: string, ramo: JourneyRamo): string {
  // Residencial tem prompts próprios (res_*) — não há locução de veículo pra trocar.
  if (ramo === 'auto' || ramo === 'residencial') return text;
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

/**
 * Jornada residencial em MODO VALIDAÇÃO (Jera 01/09): pergunta tudo que o motor
 * `residence` exige pra entendermos o retorno das seguradoras; o corte pro funil
 * curto vem depois, com quem conhece o produto. Os 4 steps de endereço só
 * aparecem quando o lookup do CEP não os preencheu.
 */
export const RESIDENCIAL_STEP_ORDER = [
  'name',
  'res_zip',
  'res_street',
  'res_neighborhood',
  'res_city',
  'res_state',
  'res_number',
  'res_complement',
  'res_segment',
  'res_construction',
  'res_residence_type',
  'res_building_value',
  'res_content_value',
  'res_condominium',
  'res_alarm',
  'res_grills',
  'res_countryside',
  'res_owner',
  'res_new',
  'renewal_status',
  'renewal_bonus',
  'contact',
  'driver_sex',
  'document',
  'quote_link',
] as const;

export type StepId = (typeof STEP_ORDER)[number] | (typeof RESIDENCIAL_STEP_ORDER)[number];

/** Steps de endereço que o lookup de CEP pode responder pelo lead. */
export const RES_ADDRESS_STEPS = ['res_street', 'res_neighborhood', 'res_city', 'res_state'] as const;

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
  // Residencial
  res_zip: 'Qual o CEP do imóvel que você quer segurar? Pode mandar só os números.',
  res_street: 'Qual o nome da rua? (Só o nome, sem o número.)',
  res_neighborhood: 'Qual o bairro?',
  res_city: 'Qual a cidade?',
  res_state: 'Qual o estado? Pode ser a sigla — SC, SP, RJ…',
  res_number: 'Qual o número do imóvel?',
  res_complement: 'Tem complemento — apartamento, bloco, casa dos fundos? Se não tiver, é só dizer "não".',
  res_segment: 'O imóvel é casa ou apartamento?',
  res_construction: 'A construção é de alvenaria, madeira ou mista?',
  res_residence_type: 'É a sua moradia habitual ou uma casa de veraneio?',
  res_building_value: 'Quanto vale a construção do imóvel, sem contar o terreno? Pode ser aproximado — ex.: 350 mil.',
  res_content_value: 'E o conteúdo — móveis, eletrônicos, eletrodomésticos? Um valor aproximado, ex.: 50 mil.',
  res_condominium: 'O imóvel fica em condomínio fechado?',
  res_alarm: 'Tem alarme contra roubo?',
  res_grills: 'As janelas têm grade?',
  res_countryside: 'Fica em zona rural?',
  res_owner: 'Você é o proprietário do imóvel?',
  res_new: 'Em caso de sinistro, quer a reposição pelo valor de novo (sem desconto pelo uso)?',
};

export /**
 * Decide se um step deve ser PULADO com base nas respostas já dadas.
 * Steps condicionais do questionário de risco (Jera 2026-05-17).
 */
function shouldSkipStep(stepId: StepId, answers: Record<string, { rawValue?: string; value?: string }>): boolean {
  // Endereço já veio do lookup de CEP → não perguntar o que a base respondeu.
  if ((RES_ADDRESS_STEPS as readonly string[]).includes(stepId)) {
    return Boolean(answers[stepId]?.rawValue);
  }
  // Contato já conhecido (no WhatsApp é o número da conversa) → não pergunta.
  if (stepId === 'contact') {
    return Boolean(answers.contact?.rawValue);
  }
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

/**
 * Ordem de perguntas do ramo cravado na sessão. Se o step atual não pertence a
 * ela (sessão semeada sem insurance_branch, por exemplo), vale a ordem que o
 * contém — um step nunca pode ficar sem sucessor por causa do rótulo do ramo.
 */
function stepOrderFor(stepId: StepId, answers: Record<string, { rawValue?: string; value?: string }>): readonly StepId[] {
  const preferred: readonly StepId[] = ramoFromAnswers(answers) === 'residencial' ? RESIDENCIAL_STEP_ORDER : STEP_ORDER;
  if (preferred.includes(stepId)) return preferred;
  return preferred === STEP_ORDER ? RESIDENCIAL_STEP_ORDER : STEP_ORDER;
}

export function nextStepAfter(stepId: StepId, answers: Record<string, { rawValue?: string; value?: string }> = {}): SessionState['stepId'] {
  const order = stepOrderFor(stepId, answers);
  const idx = order.indexOf(stepId);
  if (idx === -1 || idx >= order.length - 1) return 'complete';
  for (let i = idx + 1; i < order.length; i += 1) {
    const candidate = order[i];
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
function setBranchAndStartJourney(session: SessionState, ramo: JourneyRamo): SessionState {
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
