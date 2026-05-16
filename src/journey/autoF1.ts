import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createCallbackId, postCalcular, type CalcularPayload, type CalcularResult } from '../segfy/calcular.js';
import { openSocket, closeSocket, waitForSocketConnect, type SocketEvent, type SocketSession } from '../segfy/socket.js';
import { getQuoteSummary, type QuoteSummary } from '../quote/summary.js';
import { dumpJSON } from '../utils/logger.js';

const DEFAULT_QUOTE_TIMEOUT_MS = 45000;
const MAX_QUOTE_TIMEOUT_MS = 90000;
const RESULT_IDLE_MS = 4000;

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
  zip_code: z.string().trim().optional().default(''),
  residence_type: z.string().trim().optional().default('apartment'),
  residence_garage: z.string().trim().optional().default('yes_with_electronic_gate'),
  marital_status: z.string().trim().optional().default('married'),
  coverage: z.string().trim().min(2),
  contact: z.string().trim().optional().default(''),
  driver_birth_date: z.string().trim().min(8),
  driver_sex: z.string().trim().min(3),
  document: z.string().trim().min(11),
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

function dateInSaoPaulo(offsetYears = 0): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear() + offsetYears, now.getUTCMonth(), now.getUTCDate(), 12));
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

function normalizeRenewal(value: string): { insurer: string } {
  const v = value.trim().toLowerCase();
  if (v === 'renewal' || v.includes('renov')) return { insurer: 'renewal' };
  return { insurer: 'new' };
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

function usageQuestionnaire(
  usage: string,
  residenceType: 'house' | 'apartment',
  residenceGarage: string,
): Record<string, unknown> {
  const lower = usage.toLowerCase();
  const trabalho = lower.includes('trabalho');
  const empresa = lower.includes('empresa') || lower.includes('frota');

  return {
    utilization_type: 'personal',
    other_driver: 'does_not_exist',
    study_garage: 'does_not_study',
    job_garage: trabalho ? 'yes_private_garage' : 'does_not_work',
    work_distance: trabalho ? 20 : 0,
    tax_exemption: 'not_applicable',
    monthly_km: trabalho ? 1500 : empresa ? 1800 : 800,
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
  const renewal = normalizeRenewal(answers.renewal_status);
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
      questionnaire: usageQuestionnaire(answers.usage, residenceType, residenceGarage),
      main_driver: {
        name,
        birth_date: birthDate,
        profession: 'Empresario',
        sex,
        marital_status: maritalStatus,
        relationship: 'himself',
        document,
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

  while (Date.now() - startedAt < timeoutMs) {
    const resultCount = session.events.filter((event) => eventAction(event) === 'RESULT').length;

    if (session.events.length !== lastEventCount) {
      lastEventCount = session.events.length;
      lastEventAt = Date.now();
    }

    if (resultCount > 0 && Date.now() - lastEventAt >= RESULT_IDLE_MS) {
      return false;
    }

    await wait(500);
  }

  return true;
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
