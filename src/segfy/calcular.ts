import { randomUUID } from 'crypto';
import { segfyPOST, type SegfyResponse } from './client.js';

/**
 * POST /api/vehicle/version/1.0/calculate — Nova Jornada
 *
 * Diferenças do legado:
 * - JSON body (não form-urlencoded)
 * - `config.callback` carrega o `roomId` (UUID nosso) — Segfy publica resultados
 *   nesse canal via socket.io em `https://socket-io.segfy.com`
 * - O token da corretora é injetado como `config.token` pelo `segfyPOST`
 *
 * Schema do payload de 12 grupos (vigencia, seguro, localizacao, cliente, veiculo,
 * risco, condutor_principal, condutores_adicionais, cobertura, comissao) ainda é
 * Record genérico — vamos refinar quando primeiro 200 OK vier.
 */
export type CalcularPayload = Record<string, unknown>;

export interface CalcularResponse {
  id?: number | string;
  status?: string;
  [key: string]: unknown;
}

export interface CalcularResult {
  response: SegfyResponse<CalcularResponse>;
  /** UUID gerado pra esta cotação — use o mesmo como roomId no socket.io listener. */
  callbackId: string;
}

export function createCallbackId(): string {
  return randomUUID();
}

export async function postCalcular(payload: CalcularPayload, callbackId = createCallbackId()): Promise<CalcularResult> {
  const fullPayload = {
    ...payload,
    config: {
      ...(typeof payload.config === 'object' && payload.config !== null ? payload.config : {}),
      callback: callbackId,
    },
  };
  const response = await segfyPOST<CalcularResponse>(
    '/api/vehicle/version/1.0/calculate',
    fullPayload,
    `calcular_${callbackId.slice(0, 8)}`,
    'body_config_token',
  );
  return { response, callbackId };
}
