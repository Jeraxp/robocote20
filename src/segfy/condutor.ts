import { segfyPOST, type SegfyResponse } from './client.js';

/**
 * Lookup de pessoa física por CPF via Nova Jornada Vehicle.
 *
 * Endpoint: POST /api/vehicle/version/1.0/insured
 * Confirmado por sondagem TAILA em 2026-05-17 — undocumented mas funcional.
 * Retorna: name, birth_date (ISO), gender (male/female), cellphone, email.
 *
 * Usado pra dois cenários no Robocote 2.0:
 *   1. Step `document` (CPF do segurado) → auto-preenche driver_birth_date + driver_sex.
 *   2. Step `main_driver_document` (CPF do condutor principal, quando ≠ segurado)
 *      → auto-preenche dados do condutor pro payload Segfy sem perguntar nome.
 *
 * O stub anterior dizia "não disponível em NJ Vehicle". Falso — está disponível.
 */

export interface CondutorInsuredData {
  id: string;
  intranet_id?: number;
  document: string;
  kind: 'natural' | 'legal' | string;
  name: string;
  birth_date: string;
  gender: 'male' | 'female';
  email: string | null;
  cellphone: string | null;
}

export interface CondutorInsuredResponse {
  status: string;
  guid: string;
  message: string;
  data: CondutorInsuredData;
}

export async function lookupInsuredByCpf(cpf: string): Promise<SegfyResponse<CondutorInsuredResponse>> {
  const cleaned = cpf.replace(/\D/g, '');
  return segfyPOST<CondutorInsuredResponse>(
    '/api/vehicle/version/1.0/insured',
    { data: { document: cleaned } },
    `insured_${cleaned.slice(0, 3)}`,
    'body_config_token',
  );
}

export interface CondutorLookupOutcome {
  ok: boolean;
  data?: CondutorInsuredData;
  reason?: string;
}

/** Helper resiliente — engole erros e devolve null se algo falhar. */
export async function buscarCondutor(cpf: string): Promise<CondutorLookupOutcome> {
  try {
    const resp = await lookupInsuredByCpf(cpf);
    if (resp.body?.status === 'OK' && resp.body.data?.birth_date && resp.body.data?.gender) {
      return { ok: true, data: resp.body.data };
    }
    return { ok: false, reason: 'no_data_in_response' };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
