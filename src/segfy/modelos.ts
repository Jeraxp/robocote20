import { segfyPOST, type SegfyResponse } from './client.js';
import type { VehicleTypeNJ } from './marcas.js';

export interface Modelo {
  model_id: string;
  value: string;
  text: string;
  fuel_type: string;
  data_fipe?: {
    fipe_url?: string;
    fipe_code?: string;
    fipe_value?: number;
  };
}

export interface ModelosResponse {
  models: Modelo[];
}

/**
 * POST /api/vehicle/version/1.0/model-list — Nova Jornada
 * Requer `brand_id` UUID da NJ, `vehicle_type` (car/motorcycle/truck) e `model_year`.
 */
export async function getModelos(
  brand_id: string,
  model_year: number,
  vehicle_type: VehicleTypeNJ = 'car',
): Promise<SegfyResponse<ModelosResponse>> {
  const response = await segfyPOST<{ status: string; data?: ModelosResponse }>(
    '/api/vehicle/version/1.0/model-list',
    { data: { brand_id, vehicle_type, model_year } },
    `modelos_${vehicle_type}_${model_year}`,
    'body_config_token',
  );

  return {
    ...response,
    body: response.body.data ?? { models: [] },
  };
}
