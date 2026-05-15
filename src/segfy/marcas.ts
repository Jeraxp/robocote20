import { segfyPOST, type SegfyResponse } from './client.js';

export type TipoVeiculo = 'carro' | 'moto' | 'caminhao';
export type VehicleTypeNJ = 'car' | 'motorcycle' | 'truck';
export interface Marca {
  id: string;
  vehicle_type: VehicleTypeNJ;
  value: string;
  text: string;
}

const vehicleTypeByTipo: Record<TipoVeiculo, VehicleTypeNJ> = {
  carro: 'car',
  moto: 'motorcycle',
  caminhao: 'truck',
};

/**
 * POST /api/vehicle/version/1.0/brand-list — Nova Jornada
 * Envelope oficial observado: `{ config: { token }, data: {} }`.
 * A API retorna todas as marcas; filtramos pelo tipo equivalente ao UX pt-BR.
 */
export async function getMarcas(tipo: TipoVeiculo): Promise<SegfyResponse<Marca[]>> {
  const response = await segfyPOST<{ status: string; data?: Marca[] }>(
    '/api/vehicle/version/1.0/brand-list',
    { data: {} },
    `marcas_${tipo}`,
    'body_config_token',
  );

  const data = Array.isArray(response.body.data) ? response.body.data : [];
  return {
    ...response,
    body: data.filter((marca) => marca.vehicle_type === vehicleTypeByTipo[tipo]),
  };
}
