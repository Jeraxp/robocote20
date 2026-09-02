import { createCallbackId, postCalcular, type CalcularPayload } from '../segfy/calcular.js';
import { getInsurersForResidence } from '../segfy/companies.js';
import { openSocket, closeSocket, waitForSocketConnect } from '../segfy/socket.js';
import { splitStreetType, normalizeUf, SEGFY_STREET_TYPES } from '../segfy/cep.js';
import { getQuoteSummary, type QuoteSummary } from '../quote/summary.js';
import { dumpJSON } from '../utils/logger.js';
import { getTenantQuoteConfig, type CoverageResidencial } from '../tenant/quoteConfig.js';
import {
  DEFAULT_QUOTE_TIMEOUT_MS,
  MAX_QUOTE_TIMEOUT_MS,
  REAL_MODE,
  buildReference,
  calculateStatus,
  dateInSaoPaulo,
  eventCounts,
  extractGuid,
  normalizeDate,
  normalizeDigits,
  normalizeRenewal,
  normalizeSex,
  wait,
  waitForResultWindow,
  type AutoF1QuoteRun,
} from './autoF1.js';

/**
 * Jornada residencial — POST /api/residence/version/1.0/calculate.
 *
 * MODO VALIDAÇÃO (Jera 2026-09-01): a jornada pergunta TUDO que a API exige pra
 * entendermos o retorno; o corte do questionário vem depois, com os C-Level.
 * Por isso aqui nada é chutado: campo obrigatório ausente → erro descritivo,
 * não default silencioso (o normalizeZip do auto com fallback Av. Paulista
 * seria uma cotação errada neste ramo — o CEP É o risco).
 *
 * A mecânica socket → calculate → janela de resultados → show-results é a
 * mesma do auto e vem das helpers de autoF1.ts; só o payload e o path mudam.
 */

/** rawValue por stepId, como a sessão grava (contrato com core/conversation). */
export interface ResidencialQuoteRequest {
  answers: Record<string, string>;
}

const SEGMENTS = new Set(['house', 'apartment']);
const CONSTRUCTIONS = new Set(['masonry', 'wood', 'mixed']);
const RESIDENCE_TYPES = new Set(['habitual', 'summer_house']);

const REQUIRED_ANSWERS = [
  'name', 'document', 'driver_sex',
  'res_zip', 'res_street', 'res_number', 'res_neighborhood', 'res_city', 'res_state',
  'res_segment', 'res_construction', 'res_residence_type',
] as const;

function answer(answers: Record<string, string>, id: string): string {
  return (answers[id] ?? '').trim();
}

function isYes(value: string): boolean {
  return /^(yes|sim|s|true|1)$/i.test(value.trim());
}

/** "350000", "R$ 350.000,00" e "350 mil" viram inteiro em reais; vazio/inválido = 0. */
export function parseMoney(value: string): number {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (!trimmed) return 0;
  const milMatch = /^r?\$?\s*([\d.,]+)\s*mil$/.exec(trimmed);
  if (milMatch) {
    const base = Number(milMatch[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(base) ? Math.round(base * 1000) : 0;
  }
  // Centavos só entram quando o separador decimal é inequívoco (",dd" no fim).
  const withCents = /^r?\$?\s*([\d.]+),(\d{2})$/.exec(trimmed);
  if (withCents) {
    const n = Number(`${withCents[1].replace(/\./g, '')}.${withCents[2]}`);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const digits = trimmed.replace(/\D/g, '');
  const n = Number(digits);
  return digits && Number.isFinite(n) ? n : 0;
}

function customerType(document: string): 'private_individual' | 'legal_entity' {
  return document.length === 14 ? 'legal_entity' : 'private_individual';
}

function enumOrThrow(set: Set<string>, value: string, field: string): string {
  const v = value.trim().toLowerCase();
  if (!set.has(v)) {
    throw new Error(`Resposta "${field}" fora do esperado para cotar o imóvel: "${value}".`);
  }
  return v;
}

/** Deriva `sum` do que o lead segurou. Nenhum valor → não há o que cotar. */
export function deriveSum(buildingValue: number, contentValue: number): 'building_content' | 'building' | 'content' {
  if (buildingValue > 0 && contentValue > 0) return 'building_content';
  if (buildingValue > 0) return 'building';
  if (contentValue > 0) return 'content';
  throw new Error('Informe o valor do imóvel e/ou do conteúdo para cotar.');
}

function assertRequired(answers: Record<string, string>): void {
  const missing = REQUIRED_ANSWERS.filter((id) => !answer(answers, id));
  if (missing.length > 0) {
    throw new Error(`Faltam respostas para cotar o imóvel: ${missing.join(', ')}.`);
  }
}

/**
 * Mapeia CoverageResidencial (padrões da corretora, no painel) + valores do lead
 * pro bloco `coverage` da Segfy. `fire` (incêndio) é a cobertura básica: soma do
 * que está segurado. building_value/content_value só entram quando > 0 — os
 * títulos deles estão trocados no swagger, confie no nome do campo.
 */
function mapResidencialCoverageToSegfy(
  c: CoverageResidencial,
  buildingValue: number,
  contentValue: number,
): Record<string, unknown> {
  return {
    sum: deriveSum(buildingValue, contentValue),
    ...(buildingValue > 0 ? { building_value: buildingValue } : {}),
    ...(contentValue > 0 ? { content_value: contentValue } : {}),
    fire: buildingValue + contentValue,
    electrical_damages: c.danos_eletricos,
    pipes: c.tubulacoes,
    rent_payment: c.pagamento_aluguel,
    glasses: c.quebra_vidros,
    recomposition_documents: c.recomposicao_documentos,
    family: c.rc_familiar,
    theft: c.roubo_furto,
    wind: c.vendaval,
    vehicle_impact: c.impacto_veiculo,
    moral_damages: c.danos_morais,
    landslip: c.desmoronamento,
    earthquake: c.terremoto,
    assistance: c.assistencia,
  };
}

export function buildResidencialPayload(
  answers: Record<string, string>,
  coverage: CoverageResidencial,
  insurers: Array<{ name: string; commission: number }>,
  callbackId: string,
  reference: string,
): unknown {
  assertRequired(answers);

  const document = normalizeDigits(answer(answers, 'document'));
  if (document.length !== 11 && document.length !== 14) {
    throw new Error('Documento precisa ser CPF (11 dígitos) ou CNPJ (14 dígitos).');
  }
  const zip = normalizeDigits(answer(answers, 'res_zip'));
  if (zip.length !== 8) {
    throw new Error('CEP do imóvel precisa ter 8 dígitos.');
  }

  const startDate = dateInSaoPaulo();
  const endDate = dateInSaoPaulo(1);
  const celphone = normalizeDigits(answer(answers, 'contact'));
  const birthDateRaw = answer(answers, 'driver_birth_date');
  const buildingValue = parseMoney(answer(answers, 'res_building_value'));
  const contentValue = parseMoney(answer(answers, 'res_content_value'));

  // Tipo de logradouro: veio do lookup (enum Segfy) ou se extrai do nome informado.
  const streetAnswer = answer(answers, 'res_street');
  const explicitType = answer(answers, 'res_street_type').toLowerCase();
  const split = explicitType && SEGFY_STREET_TYPES.has(explicitType)
    ? { streetType: explicitType, street: streetAnswer }
    : splitStreetType(streetAnswer);
  const complement = answer(answers, 'res_complement');

  const payload: CalcularPayload = {
    config: {
      insurers,
      reference,
      callback: callbackId,
    },
    data: {
      quotation_id: reference,
      quotation_date: startDate,
      validity_start: startDate,
      validity_end: endDate,
      renewal: normalizeRenewal(answer(answers, 'renewal_status'), answer(answers, 'renewal_bonus')),
      customer: {
        document,
        name: answer(answers, 'name'),
        type: customerType(document),
        sex: normalizeSex(answer(answers, 'driver_sex')),
        email: '',
        // Grafia da Segfy no residence: 'celphone', 1 L (vehicle usa 'cellphone').
        celphone,
        ...(birthDateRaw ? { birth_date: normalizeDate(birthDateRaw) } : {}),
      },
      residence: {
        zip_code: zip,
        segment: enumOrThrow(SEGMENTS, answer(answers, 'res_segment'), 'res_segment'),
        type_construction: enumOrThrow(CONSTRUCTIONS, answer(answers, 'res_construction'), 'res_construction'),
        type_residence: enumOrThrow(RESIDENCE_TYPES, answer(answers, 'res_residence_type'), 'res_residence_type'),
        type_street: split.streetType,
        street: split.street,
        number: answer(answers, 'res_number'),
        ...(complement ? { complement } : {}),
        neighborhood: answer(answers, 'res_neighborhood'),
        city: answer(answers, 'res_city'),
        state: normalizeUf(answer(answers, 'res_state')),
      },
      coverage: mapResidencialCoverageToSegfy(coverage, buildingValue, contentValue),
      // Ausente = false: quem não respondeu não afirmou o agravo nem o desconto.
      questionnaire_residence: {
        condominium: isYes(answer(answers, 'res_condominium')),
        alarm: isYes(answer(answers, 'res_alarm')),
        window_grills: isYes(answer(answers, 'res_grills')),
        countryside: isYes(answer(answers, 'res_countryside')),
        insured_owner: isYes(answer(answers, 'res_owner')),
        new_property: isYes(answer(answers, 'res_new')),
      },
    },
  };

  return payload;
}

async function getResidencialSummaryWithRetry(guid: string): Promise<QuoteSummary> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      // getQuoteSummary roteia o show-results pelo ramo (camada de apresentação).
      return await getQuoteSummary(guid, undefined, undefined, 'residencial');
    } catch (e) {
      lastError = e as Error;
      await wait(1500);
    }
  }
  throw lastError ?? new Error('Não foi possível normalizar o resultado da cotação.');
}

export async function runResidencialQuote(
  request: ResidencialQuoteRequest,
  timeoutMs = DEFAULT_QUOTE_TIMEOUT_MS,
  tenantId?: string,
): Promise<AutoF1QuoteRun> {
  const startedAt = Date.now();
  const callbackId = createCallbackId();
  const safeTimeoutMs = Math.min(Math.max(timeoutMs, 5000), MAX_QUOTE_TIMEOUT_MS);
  const mode = request.answers.mode?.trim() || REAL_MODE;

  const effectiveTenantId = (tenantId ?? process.env.ROBOCOTE_TENANT_ID ?? 'rpi').trim();
  const config = await getTenantQuoteConfig(effectiveTenantId);
  const coverage = config.coberturas?.residencial;
  if (!coverage) {
    throw new Error(`Tenant "${effectiveTenantId}" não tem cobertura residencial configurada. Complete o onboarding antes de cotar.`);
  }

  // Mesmo modelo universal do auto: todas as ativas do ramo; comissão do painel
  // (quando definida) vale pra todas, senão a que a corretora tem com cada uma.
  const universe = await getInsurersForResidence();
  if (universe.length === 0) {
    throw new Error('A lista de seguradoras do ramo residencial voltou vazia.');
  }
  const ramoCommission = config.comissoes?.residencial;
  const insurers = universe.map((ins) => ({
    name: ins.name,
    commission: ramoCommission ?? ins.commission,
  }));

  const reference = buildReference('res');
  const payload = buildResidencialPayload(request.answers, coverage, insurers, callbackId, reference) as CalcularPayload;
  const session = openSocket(callbackId);

  try {
    await waitForSocketConnect(session, 8000);
    const calculate = await postCalcular(payload, callbackId, 'residence');
    const guid = extractGuid(calculate);
    const timedOut = await waitForResultWindow(session, safeTimeoutMs);
    const events = await closeSocket(session, `res_f1_${callbackId.slice(0, 8)}`);
    const quoteSummary = await getResidencialSummaryWithRetry(guid);
    const counts = eventCounts(events);

    const response: AutoF1QuoteRun = {
      ok: true,
      source: 'segfy-calculate-socket',
      guid,
      callbackId,
      quoteRoomPath: `/quote-room/${guid}`,
      quoteSummary,
      socketConnectedBeforeCalculate: true,
      calculateStatus: calculateStatus(calculate),
      mode,
      vehicleProfile: 'none',
      ramo: 'residencial',
      events: {
        ...counts,
        timedOut,
      },
      elapsedMs: Date.now() - startedAt,
    };

    await dumpJSON(`res_f1_result_${guid}`, {
      callbackId,
      guid,
      mode,
      ramo: 'residencial',
      events: response.events,
      elapsedMs: response.elapsedMs,
      quoteSummary,
    });

    return response;
  } catch (e) {
    await closeSocket(session, `res_f1_${callbackId.slice(0, 8)}_aborted`);
    throw e;
  }
}
