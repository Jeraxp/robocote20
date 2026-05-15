import { segfyPOST, type SegfyResponse } from './client.js';

export interface ResultadoRequest {
  guid?: string;
  id?: string;
  multicalculo_id?: string;
}

export interface ResultadoResponse {
  status?: string;
  guid?: string;
  id?: string;
  quotation_id?: string;
  results?: unknown[];
  [key: string]: unknown;
}

/**
 * POST /api/vehicle/version/1.0/show-results — Nova Jornada.
 *
 * Fallback de reconciliação: recupera resultados já chegados de uma cotação.
 * Em tempo real, use socket.io aberto antes de `/calculate`.
 */
export async function getResultado(
  request: ResultadoRequest | string,
): Promise<SegfyResponse<ResultadoResponse>> {
  const data = typeof request === 'string'
    ? { guid: request, id: '', multicalculo_id: '' }
    : {
        guid: request.guid ?? '',
        id: request.id ?? '',
        multicalculo_id: request.multicalculo_id ?? '',
      };

  return segfyPOST<ResultadoResponse>(
    '/api/vehicle/version/1.0/show-results',
    { data },
    `show_results_${data.guid || data.id || data.multicalculo_id || 'unknown'}`,
    'body_config_token',
  );
}
