import { segfyPOST, type SegfyResponse } from './client.js';

export interface SeguradoraRenovacao {
  id?: number | string;
  text?: string;
  nome?: string;
  [key: string]: unknown;
}

/**
 * POST /api/vehicle/version/1.0/renewal-list — Nova Jornada
 * Lista seguradoras usadas quando o seguro é renovação.
 */
export async function getRenovacao(): Promise<SegfyResponse<SeguradoraRenovacao[]>> {
  const response = await segfyPOST<{ status: string; data?: SeguradoraRenovacao[] }>(
    '/api/vehicle/version/1.0/renewal-list',
    { data: {} },
    'renovacao',
    'body_config_token',
  );

  return {
    ...response,
    body: Array.isArray(response.body.data) ? response.body.data : [],
  };
}
