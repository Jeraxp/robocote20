import { segfyPOST, type SegfyResponse } from './client.js';

/**
 * Decode de placa via Segfy Nova Jornada — `decode-plate`.
 *
 * Endpoint NÃO documentado no Swagger oficial, mas funcional em produção.
 * Confirmado por sondagem em 2026-05-17 (TAILA): responde com brand/model/year/chassis/FIPE.
 *
 * Permite o Path A do questionário Auto F1: lead manda placa → preenchemos marca,
 * modelo e ano automaticamente, pulando 3 perguntas. Se decode falhar, fluxo cai
 * para Path B (lead digita marca/modelo manualmente).
 */

export interface PlacaBrand {
  id: string;
  vehicle_type: string;
  value: string;
  text: string;
}

export interface PlacaModelFipe {
  fipe_code: string;
  fipe_value: number;
  fipe_url?: string;
}

export interface PlacaModel {
  model_id: string;
  value: string;
  text: string;
  fuel_type: string;
  zero_km?: boolean;
  alienated?: boolean;
  chassis_relabeled?: boolean;
  armored?: boolean;
  gas_kit?: boolean;
  anti_theft?: boolean;
  data_fipe: PlacaModelFipe;
}

export interface DecodePlateData {
  manufacture_year: number;
  model_year: number;
  chassis: string;
  brands: PlacaBrand[];
  models: PlacaModel[];
}

export interface DecodePlateResponse {
  status: string;
  guid: string;
  message: string;
  data?: DecodePlateData;
  perform?: string;
}

/** Formato placa Mercosul (ABC1D23) ou antigo (ABC1234). Removemos hífen/espaço/case. */
export function normalizePlate(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function isValidPlateFormat(plate: string): boolean {
  const p = normalizePlate(plate);
  if (p.length !== 7) return false;
  // Antigo: AAA1234. Mercosul: AAA1A23 (letra na 5ª pos).
  return /^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/.test(p);
}

/**
 * POST /api/vehicle/version/1.0/decode-plate (undocumented, validado 2026-05-17)
 * Envelope: `{ config: { token }, data: { plate } }` no padrão NJ.
 *
 * Retorna `status: OK` + brands[]/models[]/years quando placa existe na base.
 * Status diferente ou data vazia → fallback pra Path B (manual).
 */
export async function decodePlate(plate: string): Promise<SegfyResponse<DecodePlateResponse>> {
  const cleaned = normalizePlate(plate);
  return segfyPOST<DecodePlateResponse>(
    '/api/vehicle/version/1.0/decode-plate',
    { data: { plate: cleaned } },
    `decode_plate_${cleaned.slice(0, 3)}`,
    'body_config_token',
  );
}

/** Resultado normalizado pra o orquestrador montar 3 answers (brand/year/model) de uma vez. */
export interface PlateDecodeOutcome {
  ok: boolean;
  brand?: { id: string; value: string; text: string };
  modelYear?: number;
  model?: {
    id: string;
    value: string;
    text: string;
    fuelType: string;
    fipeCode: string;
    fipeValue: number | null;
  };
  chassis?: string;
}

export function pickPlateDecodeOutcome(resp: DecodePlateResponse): PlateDecodeOutcome {
  if (resp.status !== 'OK' || !resp.data) return { ok: false };
  const { brands, models, model_year, chassis } = resp.data;
  const brand = brands?.[0];
  const model = models?.[0];
  if (!brand || !model) return { ok: false };
  return {
    ok: true,
    brand: { id: brand.id, value: brand.value, text: brand.text },
    modelYear: model_year,
    model: {
      id: model.model_id,
      value: model.value,
      text: model.text,
      fuelType: model.fuel_type,
      fipeCode: model.data_fipe?.fipe_code ?? '',
      fipeValue: model.data_fipe?.fipe_value ?? null,
    },
    chassis: chassis ?? undefined,
  };
}

/** Compat com rota legacy `/test/placa/:placa` do spike — agora retorna decode real. */
export async function buscarPorPlaca(placa: string): Promise<{ ok: true; outcome: PlateDecodeOutcome; raw: DecodePlateResponse } | { ok: false; reason: string }> {
  if (!isValidPlateFormat(placa)) {
    return { ok: false, reason: 'Formato de placa inválido (esperado AAA9A99 Mercosul ou AAA9999 antigo).' };
  }
  try {
    const resp = await decodePlate(placa);
    const outcome = pickPlateDecodeOutcome(resp.body);
    return { ok: true, outcome, raw: resp.body };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
