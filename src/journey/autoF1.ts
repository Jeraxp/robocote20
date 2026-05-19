import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createCallbackId, postCalcular, type CalcularPayload, type CalcularResult } from '../segfy/calcular.js';
import { openSocket, closeSocket, waitForSocketConnect, type SocketEvent, type SocketSession } from '../segfy/socket.js';
import { getQuoteSummary, type QuoteSummary } from '../quote/summary.js';
import { dumpJSON } from '../utils/logger.js';

const DEFAULT_QUOTE_TIMEOUT_MS = 45000;
const MAX_QUOTE_TIMEOUT_MS = 90000;
// Quando 1 seguradora responde rápido com exception e as outras demoram, 4s era
// curto demais e desconectava antes das demais retornarem. Subido pra 15s.
const RESULT_IDLE_MS = 15000;
// Tempo mínimo de espera após receber o 1º RESULT, dando chance pras seguradoras
// lentas responderem mesmo que a Segfy não emita mais STEPs.
const MIN_WAIT_AFTER_FIRST_RESULT_MS = 12000;

export const REAL_MODE = 'real';

const autoF1AnswersSchema = z.object({
  name: z.string().trim().min(2).refine((value) => value.split(/\s+/).filter(Boolean).length >= 2, {
    message: 'nome completo com sobrenome é obrigatório',
  }),
  mode: z.string().trim().min(2).default(REAL_MODE),
  vehicle_brand: z.string().trim().min(1, 'marca do veículo é obrigatória'),
  vehicle_brand_text: z.string().trim().min(1, 'texto da marca do veículo é obrigatório'),
  vehicle_year: z.string().trim().min(4, 'ano do veículo é obrigatório'),
  vehicle_model: z.string().trim().min(1, 'modelo do veículo é obrigatório'),
  vehicle_model_text: z.string().trim().min(1, 'texto do modelo do veículo é obrigatório'),
  vehicle_model_id: z.string().trim().min(1, 'id do modelo no catálogo é obrigatório'),
  vehicle_fipe_code: z.string().trim().min(1, 'código FIPE do modelo é obrigatório'),
  vehicle_fipe_value: z.string().trim().min(1, 'valor FIPE do modelo é obrigatório'),
  vehicle_fuel_type: z.string().trim().optional().default(''),
  usage: z.string().trim().min(2),
  renewal_status: z.string().trim().optional().default('new'),
  renewal_bonus: z.string().trim().optional().default(''),
  zip_code: z.string().trim().optional().default(''),
  residence_type: z.string().trim().optional().default('apartment'),
  residence_garage: z.string().trim().optional().default('yes_with_electronic_gate'),
  marital_status: z.string().trim().optional().default('married'),
  coverage: z.string().trim().min(2),
  contact: z.string().trim().optional().default(''),
  driver_birth_date: z.string().trim().min(8),
  driver_sex: z.string().trim().min(3),
  document: z.string().trim().min(11),

  // Questionário de risco (Jera 2026-05-17) — respostas reais do segurado, não chute do sistema
  is_main_driver: z.string().trim().optional().default('yes'),       // 'yes' | 'no'
  main_driver_document: z.string().trim().optional().default(''),    // CPF do condutor (se !=  segurado)
  main_driver_name: z.string().trim().optional().default(''),        // via lookup /insured
  main_driver_birth_date: z.string().trim().optional().default(''),  // via lookup
  main_driver_sex: z.string().trim().optional().default(''),         // via lookup
  young_driver: z.string().trim().optional().default('no'),          // 'yes' | 'no'
  studies: z.string().trim().optional().default('no'),               // 'yes' | 'no'
  study_garage: z.string().trim().optional().default('no'),          // 'yes' | 'no' (só relevante se studies=yes)
  work_commute: z.string().trim().optional().default('no'),          // 'yes' | 'no'
  work_garage: z.string().trim().optional().default('no'),           // 'yes' | 'no' (só relevante se work_commute=yes)
  monthly_km: z.string().trim().optional().default('1000'),          // estimativa numérica
});

export const autoF1QuoteRequestSchema = z.object({
  answers: autoF1AnswersSchema,
});

export type AutoF1QuoteRequest = z.infer<typeof autoF1QuoteRequestSchema>;

export interface AutoF1QuoteRun {
  ok: true;
  source: 'segfy-calculate-socket';
  guid: string;
  callbackId: string;
  quoteRoomPath: string;
  quoteSummary: QuoteSummary;
  socketConnectedBeforeCalculate: true;
  calculateStatus: string;
  mode: string;
  vehicleProfile: 'catalog_fipe';
  events: {
    total: number;
    result: number;
    pdf: number;
    step: number;
    timedOut: boolean;
  };
  elapsedMs: number;
}

function dateInSaoPaulo(offsetYears = 0, offsetDays = 0): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear() + offsetYears, now.getUTCMonth(), now.getUTCDate() + offsetDays, 12));
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) return trimmed;

  const brMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (brMatch) return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;

  // DDMMAAAA cru (lead WhatsApp digita data sem barras)
  const cruMatch = /^(\d{2})(\d{2})(\d{4})$/.exec(trimmed);
  if (cruMatch) return `${cruMatch[3]}-${cruMatch[2]}-${cruMatch[1]}`;

  return trimmed;
}

function normalizeSex(value: string): 'male' | 'female' {
  return value.toLowerCase().startsWith('f') ? 'female' : 'male';
}

function normalizeMaritalStatus(value: string): string {
  const v = value.trim().toLowerCase();
  if (['single', 'solteiro', 'solteira'].some((m) => v.includes(m))) return 'single';
  if (['married', 'casado', 'casada', 'união'].some((m) => v.includes(m))) return 'married';
  if (['divorced', 'divorciad', 'separad'].some((m) => v.includes(m))) return 'divorced';
  if (['widowed', 'viuv'].some((m) => v.includes(m))) return 'widowed';
  return 'married';
}

function isRenewalStatus(value: string): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return /reno|renew/.test(v);
}

/**
 * Decide o bloco `renewal` do payload Segfy.
 *
 * - Novo seguro → `{ insurer: 'new' }` (única opção que dispensa demais campos).
 * - Renovação  → `{ insurer: 'allianz', bonus_current, prior_policy, prior_policy_end }`.
 *   Seguradora cravada (Jera 2026-05-19) e apólice + data fim como placeholders.
 *   Apesar do swagger oficial declarar APENAS `insurer` como required, a Segfy
 *   na prática rejeita 422 quando insurer != 'new' sem `prior_policy` e
 *   `prior_policy_end`. Confirmado experimentalmente 2026-05-19.
 *   Os placeholders permitem o calculate passar; a seguradora pode aceitar ou
 *   rejeitar essa cotação na ponta dela, mas o pipeline não trava.
 */
function normalizeRenewal(statusValue: string, bonusValue: string): {
  insurer: string;
  bonus_current?: string;
  prior_policy?: string;
  prior_policy_end?: string;
} {
  if (!isRenewalStatus(statusValue)) return { insurer: 'new' };
  const bonus = normalizeBonusClass(bonusValue);
  return {
    insurer: 'allianz',
    bonus_current: bonus,
    prior_policy: '0000000000',
    prior_policy_end: dateInSaoPaulo(0, 30),
  };
}

/** Aceita "5", "classe 5", "bônus 7", "10" — retorna "0".."10" como string. */
function normalizeBonusClass(value: string): string {
  const m = String(value ?? '').match(/\d+/);
  if (!m) return '0';
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n > 10) return '10';
  return String(n);
}

function normalizeResidenceType(value: string): 'house' | 'apartment' {
  const v = value.trim().toLowerCase();
  return v.startsWith('h') || v.includes('casa') ? 'house' : 'apartment';
}

function normalizeGarage(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.includes('yes_with') || v.includes('eletr') || v === 'yes_with_electronic_gate') return 'yes_with_electronic_gate';
  if (v.includes('yes_no') || v.includes('sem port')) return 'yes_no_electronic_gate';
  if (v.includes('no') && (v.includes('garage') || v.includes('garagem'))) return 'no_garage';
  if (v === 'no_garage') return 'no_garage';
  return 'yes_with_electronic_gate';
}

function normalizeZip(value: string): string {
  const digits = normalizeDigits(value);
  if (digits.length === 8) return digits;
  return '01311000'; // fallback Av. Paulista quando vazio/inválido
}

function parseYear(value: string): number {
  const n = Number(value.trim());
  if (Number.isInteger(n) && n >= 1980 && n <= new Date().getFullYear() + 1) return n;
  throw new Error('Ano do veículo inválido.');
}

function normalizeUtilizationType(usage: string): 'personal' | 'job' | 'both' {
  const v = usage.toLowerCase();
  if (v.includes('empresa') || v.includes('frota') || v.includes('pj')) return 'job';
  if (v.includes('trabalho')) return 'both';
  return 'personal';
}

function usageQuestionnaire(
  answers: AutoF1QuoteRequest['answers'],
  residenceType: 'house' | 'apartment',
  residenceGarage: string,
): Record<string, unknown> {
  // Respostas reais do segurado (Jera 2026-05-17) — não chutar.
  // Enums oficiais do swagger Segfy NJ (calculate). Não inventar valores.
  const youngDriver = answers.young_driver === 'yes';
  const studies = answers.studies === 'yes';
  const studyHasGarage = studies && answers.study_garage === 'yes';
  const workCommute = answers.work_commute === 'yes';
  const workHasGarage = workCommute && answers.work_garage === 'yes';
  const monthlyKm = Number(answers.monthly_km) > 0 ? Number(answers.monthly_km) : 1000;

  return {
    utilization_type: normalizeUtilizationType(answers.usage),
    // young_driver=yes → "yes_both" (não perguntamos sexo do jovem, mais conservador)
    other_driver: youngDriver ? 'yes_both' : 'does_not_exist',
    // study_garage enum: 'yes' | 'no' | 'does_not_use' | 'does_not_study' | 'not_kept_in_garage'
    study_garage: !studies
      ? 'does_not_study'
      : studyHasGarage
        ? 'yes'
        : 'no',
    // job_garage enum: 'yes' | 'no' | 'does_not_use' | 'does_not_work' | 'not_kept_in_garage'
    // Quando lead não usa carro pra trabalho, optamos por 'does_not_use' (trabalha mas não usa carro).
    job_garage: !workCommute
      ? 'does_not_use'
      : workHasGarage
        ? 'yes'
        : 'no',
    work_distance: workCommute ? 20 : 0,
    tax_exemption: 'not_applicable',
    monthly_km: monthlyKm,
    residence_type: residenceType,
    residence_garage: residenceGarage,
  };
}

function buildReference(): string {
  return `robocote-f1-${dateInSaoPaulo()}-${randomUUID().slice(0, 8)}`;
}

interface ResolvedVehicleProfile {
  profile: 'catalog_fipe';
  brand: string;
  model: string;
  fipe_code: string;
  fipe_value: string;
  fuel_type: string;
  model_year: number;
  manufacture_year: number;
}

function resolveVehicle(answers: AutoF1QuoteRequest['answers']): ResolvedVehicleProfile {
  const year = parseYear(answers.vehicle_year);
  const fipeCode = answers.vehicle_fipe_code?.trim() ?? '';
  const fipeValueRaw = answers.vehicle_fipe_value?.trim() ?? '';
  const brandText = answers.vehicle_brand_text?.trim() || answers.vehicle_brand?.trim() || '';
  const modelText = answers.vehicle_model_text?.trim() || answers.vehicle_model?.trim() || '';
  const fuelType = answers.vehicle_fuel_type?.trim() || 'flex';

  if (!fipeCode || !fipeValueRaw || !brandText || !modelText) {
    throw new Error('Selecione um modelo do catálogo oficial antes de calcular.');
  }

  return {
    profile: 'catalog_fipe',
    brand: brandText,
    model: modelText,
    fipe_code: fipeCode,
    fipe_value: fipeValueRaw,
    fuel_type: fuelType,
    model_year: year,
    manufacture_year: year,
  };
}

export function buildAutoF1Payload(
  request: AutoF1QuoteRequest,
  callbackId: string,
): { payload: CalcularPayload; vehicleProfile: ResolvedVehicleProfile['profile'] } {
  const { answers } = request;
  const reference = buildReference();
  const startDate = dateInSaoPaulo();
  const endDate = dateInSaoPaulo(1);
  const document = normalizeDigits(answers.document);
  const cellphone = normalizeDigits(answers.contact);
  const birthDate = normalizeDate(answers.driver_birth_date);
  const sex = normalizeSex(answers.driver_sex);
  const name = answers.name.trim();
  const zip = normalizeZip(answers.zip_code);
  const maritalStatus = normalizeMaritalStatus(answers.marital_status);
  const renewal = normalizeRenewal(answers.renewal_status, answers.renewal_bonus);
  const residenceType = normalizeResidenceType(answers.residence_type);
  const residenceGarage = normalizeGarage(answers.residence_garage);
  const vehicle = resolveVehicle(answers);

  const payload: CalcularPayload = {
    config: {
      insurers: [{ name: 'porto', commission: 10 }],
      reference,
      callback: callbackId,
    },
    data: {
      quotation_id: reference,
      validity_start: startDate,
      validity_end: endDate,
      quotation_date: startDate,
      zip_code: zip,
      renewal,
      customer: {
        cellphone,
        name,
        birth_date: birthDate,
        sex,
        email: '',
        document,
      },
      questionnaire: usageQuestionnaire(answers, residenceType, residenceGarage),
      main_driver: {
        name: answers.is_main_driver === 'no' && answers.main_driver_name ? answers.main_driver_name : name,
        birth_date: answers.is_main_driver === 'no' && answers.main_driver_birth_date ? normalizeDate(answers.main_driver_birth_date) : birthDate,
        profession: 'Autonomo',
        sex: answers.is_main_driver === 'no' && answers.main_driver_sex ? normalizeSex(answers.main_driver_sex) : sex,
        marital_status: maritalStatus,
        relationship: answers.is_main_driver === 'no' ? 'other' : 'himself',
        document: answers.is_main_driver === 'no' && answers.main_driver_document ? normalizeDigits(answers.main_driver_document) : document,
      },
      vehicle: {
        armored: false,
        circulation_zip_code: zip,
        manufacture_year: vehicle.manufacture_year,
        fuel_type: vehicle.fuel_type,
        chassis: '',
        fipe_code: vehicle.fipe_code,
        anti_theft: false,
        plate: '',
        zero_km: false,
        model: vehicle.model,
        category_type: 'particular',
        fipe_value: vehicle.fipe_value,
        brand: vehicle.brand,
        vehicle_type: 'car',
        alienated: false,
        chassis_relabeled: false,
        model_year: vehicle.model_year,
        gas_kit: false,
      },
      coverage: {
        franchise: 'normal',
        coverage_type: 'comprehensive',
        armored_value: 0,
        assistance: 'assistance_200_km_referenced',
        exemption_franchise: false,
        death_illness: 10000,
        quick_repairs: false,
        rental_car_profile: 'no_car',
        body_injuries: 100000,
        rental_car: 'no_car',
        glass: 'glass_basic_referenced',
        replacement_zero_km: 'no_replacement',
        moral_damage: 10000,
        body_shop_repair: false,
        expense_extraordinary: 0,
        dmh: 0,
        material_damage: 100000,
        gas_kit_value: 0,
        fipe_percentage: 100,
      },
    },
  };

  return { payload, vehicleProfile: vehicle.profile };
}

function eventAction(event: SocketEvent): string {
  return String(event.action ?? event.status ?? '').toUpperCase();
}

function eventCounts(events: SocketEvent[]): AutoF1QuoteRun['events'] {
  return {
    total: events.length,
    result: events.filter((event) => eventAction(event) === 'RESULT').length,
    pdf: events.filter((event) => eventAction(event) === 'PDF').length,
    step: events.filter((event) => eventAction(event) === 'STEP').length,
    timedOut: false,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResultWindow(session: SocketSession, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  let lastEventCount = session.events.length;
  let lastEventAt = Date.now();
  let firstResultAt: number | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (session.events.length !== lastEventCount) {
      lastEventCount = session.events.length;
      lastEventAt = Date.now();
    }

    const stepCompanies = collectCompanies(session.events, 'STEP');
    const resultCompanies = collectCompanies(session.events, 'RESULT');
    const resultCount = resultCompanies.size;

    if (resultCount > 0 && firstResultAt === null) {
      firstResultAt = Date.now();
    }

    // Todas as companies que iniciaram (STEP) já retornaram RESULT — saída limpa.
    if (
      stepCompanies.size > 0 &&
      resultCount >= stepCompanies.size &&
      [...stepCompanies].every((c) => resultCompanies.has(c))
    ) {
      return false;
    }

    // Janela ociosa: nenhum evento há RESULT_IDLE_MS, mas respeitando o mínimo
    // de espera após o primeiro RESULT (algumas seguradoras demoram mais).
    if (
      resultCount > 0 &&
      Date.now() - lastEventAt >= RESULT_IDLE_MS &&
      firstResultAt !== null &&
      Date.now() - firstResultAt >= MIN_WAIT_AFTER_FIRST_RESULT_MS
    ) {
      return false;
    }

    await wait(500);
  }

  return true;
}

function collectCompanies(events: SocketEvent[], action: 'STEP' | 'RESULT'): Set<string> {
  const set = new Set<string>();
  for (const event of events) {
    if (eventAction(event) !== action) continue;
    const data = event.data as { company?: { name?: string } } | undefined;
    const name = data?.company?.name;
    if (typeof name === 'string' && name.trim()) set.add(name.trim().toLowerCase());
  }
  return set;
}

function extractGuid(result: CalcularResult): string {
  const body = result.response.body;
  if (body && typeof body === 'object' && 'guid' in body && typeof body.guid === 'string' && body.guid) {
    return body.guid;
  }
  if (body && typeof body === 'object' && 'status' in body) {
    const status = String(body.status ?? 'unknown');
    const validations = 'validations' in body ? JSON.stringify(body.validations) : '';
    throw new Error(`Segfy calculate retornou ${status}${validations ? `: ${validations}` : ''}`);
  }
  throw new Error('A Segfy respondeu o calculate, mas não devolveu GUID da cotação.');
}

function calculateStatus(result: CalcularResult): string {
  const body = result.response.body;
  if (body && typeof body === 'object' && 'status' in body) {
    return String(body.status ?? 'unknown');
  }
  return 'unknown';
}

async function getQuoteSummaryWithRetry(guid: string): Promise<QuoteSummary> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await getQuoteSummary(guid);
    } catch (e) {
      lastError = e as Error;
      await wait(1500);
    }
  }

  throw lastError ?? new Error('Não foi possível normalizar o resultado da cotação.');
}

export async function runAutoF1Quote(
  request: AutoF1QuoteRequest,
  timeoutMs = DEFAULT_QUOTE_TIMEOUT_MS,
): Promise<AutoF1QuoteRun> {
  const startedAt = Date.now();
  const callbackId = createCallbackId();
  const safeTimeoutMs = Math.min(Math.max(timeoutMs, 5000), MAX_QUOTE_TIMEOUT_MS);
  const { payload, vehicleProfile } = buildAutoF1Payload(request, callbackId);
  const session = openSocket(callbackId);

  try {
    await waitForSocketConnect(session, 8000);
    const calculate = await postCalcular(payload, callbackId);
    const guid = extractGuid(calculate);
    const timedOut = await waitForResultWindow(session, safeTimeoutMs);
    const events = await closeSocket(session, `auto_f1_${callbackId.slice(0, 8)}`);
    const quoteSummary = await getQuoteSummaryWithRetry(guid);
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
      mode: request.answers.mode,
      vehicleProfile,
      events: {
        ...counts,
        timedOut,
      },
      elapsedMs: Date.now() - startedAt,
    };

    await dumpJSON(`auto_f1_result_${guid}`, {
      callbackId,
      guid,
      mode: request.answers.mode,
      vehicleProfile,
      events: response.events,
      elapsedMs: response.elapsedMs,
      quoteSummary,
    });

    return response;
  } catch (e) {
    await closeSocket(session, `auto_f1_${callbackId.slice(0, 8)}_aborted`);
    throw e;
  }
}
