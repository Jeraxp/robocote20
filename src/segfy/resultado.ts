import { segfyPOST, type SegfyResponse } from './client.js';
import { segfyRamoPath, type SegfyRamo } from './calcular.js';

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
 * POST /api/<ramo>/version/1.0/show-results — Nova Jornada.
 *
 * Fallback de reconciliação: recupera resultados já chegados de uma cotação.
 * Em tempo real, use socket.io aberto antes de `/calculate`.
 * O body é idêntico entre vehicle e residence; só o path muda.
 */
export async function getResultado(
  request: ResultadoRequest | string,
  ramo: SegfyRamo = 'vehicle',
): Promise<SegfyResponse<ResultadoResponse>> {
  const data = typeof request === 'string'
    ? { guid: request, id: '', multicalculo_id: '' }
    : {
        guid: request.guid ?? '',
        id: request.id ?? '',
        multicalculo_id: request.multicalculo_id ?? '',
      };

  return segfyPOST<ResultadoResponse>(
    segfyRamoPath(ramo, 'show-results'),
    { data },
    `show_results_${data.guid || data.id || data.multicalculo_id || 'unknown'}`,
    'body_config_token',
  );
}
