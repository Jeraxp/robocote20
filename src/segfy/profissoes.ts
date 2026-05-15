import { segfyPOST, type SegfyResponse } from './client.js';

export interface Profissao {
  id: string;
  name: string;
}

/**
 * POST /api/vehicle/version/1.0/profession-list — Nova Jornada
 * Profissão do condutor é campo obrigatório no cálculo auto.
 */
export async function getProfissoes(): Promise<SegfyResponse<Profissao[]>> {
  const response = await segfyPOST<{ status: string; data?: Profissao[] }>(
    '/api/vehicle/version/1.0/profession-list',
    { data: {} },
    'profissoes',
    'body_config_token',
  );

  return {
    ...response,
    body: Array.isArray(response.body.data) ? response.body.data : [],
  };
}
