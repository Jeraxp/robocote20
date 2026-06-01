/**
 * Catálogo Segfy server-side pra steps que exigem opções oficiais (vehicle_brand, vehicle_model).
 *
 * No webchat, o frontend React carrega esses catálogos e envia em `catalogContext.items`
 * já filtrados pela mensagem do user. No WhatsApp não tem frontend — o backend precisa
 * carregar quando o step exige. Este módulo expõe `loadCatalogForStep` que decide
 * o que buscar com base no step atual e nas respostas anteriores.
 */

import { getMarcas, type TipoVeiculo, type VehicleTypeNJ } from '../segfy/marcas.js';
import { getModelos } from '../segfy/modelos.js';

export interface CatalogItem {
  id: string;
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionAnswerLike {
  id?: string;
  label?: string;
  value?: string;
  rawValue?: string;
  metadata?: Record<string, unknown>;
}

const STEPS_WITH_CATALOG = new Set(['vehicle_brand', 'vehicle_model']);

export function stepNeedsCatalog(stepId: string): boolean {
  return STEPS_WITH_CATALOG.has(stepId);
}

const VEHICLE_TYPE_NJ_BY_TIPO: Record<TipoVeiculo, VehicleTypeNJ> = {
  carro: 'car',
  moto: 'motorcycle',
  caminhao: 'truck',
};

/**
 * Deriva o tipo de veículo do ramo escolhido no intake (`insurance_branch`).
 * Sem esse dado (ex: webchat auto-only), assume carro — comportamento legado.
 */
function tipoFromAnswers(answers: Record<string, SessionAnswerLike>): TipoVeiculo {
  const ramo = answers.insurance_branch?.rawValue ?? answers.insurance_branch?.value ?? 'auto';
  if (ramo === 'moto') return 'moto';
  if (ramo === 'caminhao') return 'caminhao';
  return 'carro';
}

async function loadBrands(tipo: TipoVeiculo): Promise<CatalogItem[]> {
  const response = await getMarcas(tipo);
  return response.body.map((marca) => ({
    id: marca.id,
    label: marca.text,
    description: marca.value !== marca.text ? marca.value : undefined,
    metadata: { brand_text: marca.text, brand_value: marca.value },
  }));
}

function parseYear(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  if (Number.isInteger(n) && n >= 1980 && n <= new Date().getFullYear() + 1) return n;
  return null;
}

async function loadModels(answers: Record<string, SessionAnswerLike>, vehicleType: VehicleTypeNJ): Promise<CatalogItem[]> {
  const brandId = answers.vehicle_brand?.rawValue ?? answers.vehicle_brand?.value;
  const yearRaw = answers.vehicle_year?.rawValue ?? answers.vehicle_year?.value;
  const year = parseYear(yearRaw);

  if (!brandId || !year) return [];

  const response = await getModelos(brandId, year, vehicleType);
  const models = response.body.models ?? [];
  return models.map((modelo) => {
    const fipeCode = modelo.data_fipe?.fipe_code ?? '';
    const fipeValue = modelo.data_fipe?.fipe_value;
    const description = fipeCode
      ? `FIPE ${fipeCode}${typeof fipeValue === 'number' ? ` · R$ ${fipeValue.toLocaleString('pt-BR')}` : ''} · ${modelo.fuel_type}`
      : modelo.fuel_type;
    return {
      id: modelo.model_id,
      label: modelo.value,
      description,
      metadata: {
        model_id: modelo.model_id,
        fipe_code: fipeCode,
        fipe_value: fipeValue ?? null,
        fuel_type: modelo.fuel_type,
        model_text: modelo.text,
      },
    };
  });
}

/**
 * Carrega o catálogo apropriado pro step atual. Retorna [] em steps que não exigem catálogo
 * ou quando faltam pré-requisitos (ex: vehicle_model sem brand_id + year confirmados).
 */
export async function loadCatalogForStep(
  stepId: string,
  answers: Record<string, SessionAnswerLike>,
): Promise<CatalogItem[]> {
  const tipo = tipoFromAnswers(answers);
  if (stepId === 'vehicle_brand') return loadBrands(tipo);
  if (stepId === 'vehicle_model') return loadModels(answers, VEHICLE_TYPE_NJ_BY_TIPO[tipo]);
  return [];
}
