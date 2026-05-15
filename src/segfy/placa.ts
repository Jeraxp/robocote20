/**
 * Decode pela placa NÃO está disponível na Nova Jornada (ramo Vehicle).
 *
 * O doc oficial da NJ lista apenas: brand-list, model-list, profession-list,
 * renewal-list, calculate, save-customer, show-quotation, show-results.
 *
 * Fluxo correto no Robocote 2.0: usar **Path B** — usuário escolhe marca
 * (brand-list) → modelo (model-list) → segue questionário de risco.
 *
 * Esse stub existe pra preservar a rota `/test/placa/:placa` do spike e
 * documentar a indisponibilidade pros agentes que consultem essa base.
 */
export interface PlacaUnavailableResponse {
  ok: false;
  available_in_nj: false;
  fallback: 'use_path_b_brand_model';
  message: string;
}

export async function buscarPorPlaca(placa: string): Promise<PlacaUnavailableResponse> {
  void placa;
  return {
    ok: false,
    available_in_nj: false,
    fallback: 'use_path_b_brand_model',
    message: 'Decode pela placa não está disponível na Nova Jornada Vehicle. Use Path B (brand-list + model-list).',
  };
}
