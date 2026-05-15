/**
 * Lookup de condutor por CPF NÃO está disponível na Nova Jornada para Vehicle.
 *
 * O endpoint `/insured` existe SOMENTE no ramo Residence
 * (`/api/residence/version/1.0/insured`). Pro Vehicle, dados do condutor
 * precisam ser preenchidos manualmente pelo lead (Path B).
 *
 * Observação importante validada no spike Robocote 1.0 (legado):
 * o lookup CPF retorna apenas 4 campos (estado_civil, profissao_id,
 * data_habilitacao, habilitacao) — nunca preenche nome/idade/gênero/CEP.
 * Portanto, mesmo se fosse disponível na NJ, o ganho UX seria pequeno.
 */
export interface CondutorUnavailableResponse {
  ok: false;
  available_in_nj_vehicle: false;
  available_in_nj_residence: true;
  fallback: 'ask_lead_directly';
  message: string;
}

export async function buscarCondutor(cpf: string): Promise<CondutorUnavailableResponse> {
  const normalized = cpf.replace(/\D/g, '');
  const masked = normalized.length === 11 ? `${normalized.slice(0, 3)}_${normalized.slice(9)}` : 'unknown';
  return {
    ok: false,
    available_in_nj_vehicle: false,
    available_in_nj_residence: true,
    fallback: 'ask_lead_directly',
    message: `Lookup de CPF (${masked}) não está disponível na NJ Vehicle. Existe em Residence (/insured). No fluxo de Auto, pergunte os dados diretamente ao lead.`,
  };
}
