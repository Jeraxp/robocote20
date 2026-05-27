import { getPostgresPool, isPostgresConfigured } from '../db/postgres.js';

/**
 * Configuração de cotação por tenant — lida do JSON canônico em `tenant_configs`.
 *
 * Fail-fast: se tenant não tem config preenchida, lança erro descritivo.
 * Os defaults Robocote são populados via migration data (`migrations/seed_tenant_configs.sql`)
 * pra tenants criados antes desse refactor; tenants novos passam pelo wizard de onboarding.
 *
 * Esse módulo é a fonte única de verdade pra:
 *  - Defaults exibidos no fluxo conversacional do WhatsApp/webchat
 *  - Estrutura do payload pra Segfy `/calculate`
 *  - Filtragem de seguradoras habilitadas pra corretora
 *  - Comissões por ramo
 */

export type Ramo = 'auto' | 'moto' | 'caminhao' | 'residencial' | 'vida_individual' | 'vida_grupo' | 'saude' | 'rc_profissional';

/**
 * Cobertura de ramo Auto. Valores enum (franquia, tipo_cobertura, assistencia_24h, vidros,
 * carro_reserva, tipo_carro_reserva, reposicao_zero_km) DEVEM bater com os enums oficiais
 * que a Segfy NJ aceita no endpoint `/api/vehicle/version/1.0/calculate`.
 *
 * Pra evitar dupla camada de mapeamento, armazenamos os valores Segfy diretos no JSON canônico.
 * O wizard é responsável por mostrar labels amigáveis ("Compreensiva") e gravar values técnicos
 * ("comprehensive"). Ver swagger-public.json pra lista canônica de valores aceitos.
 */
export interface CoverageAuto {
  tipo_cobertura: string;     // 'comprehensive' | 'rcf' | 'fire_and_theft' | ...
  tabela_fipe: number;        // 100, 110, custom 0-200
  franquia: string;           // 'normal' | 'reduced_25' | 'reduced_50' | 'reduced_75' | 'optional_50' | ...
  isencao_franquia: boolean;
  vidros: string;             // 'glass_basic_referenced' | 'glass_complete_referenced' | 'glass_vip' | 'no_glass' | ...
  assistencia_24h: string;    // 'assistance_200_km_referenced' | 'assistance_100_km' | 'unlimited_assistance' | ...
  carro_reserva: string;      // 'no_car' | 'car_07_days' | 'car_15_days' | 'car_30_days' | ...
  tipo_carro_reserva: string; // 'no_car' | 'basic' | 'essential' | 'executive' | ...
  reposicao_zero_km: string;  // 'no_replacement' | 'replacement_06_months' | 'replacement_12_months' | ...
  rcf_dm: number;             // R$ — danos materiais
  rcf_dc: number;             // R$ — danos corporais
  danos_morais: number;       // R$
  app_morte: number;          // R$ — APP morte
  desp_extras: number;        // R$ — despesas extraordinárias
}

export interface TenantQuoteConfigShape {
  version: string;
  plano?: 'seguros' | 'saude' | 'ambos';
  ramos?: Ramo[];
  seguradoras?: string[]; // enum oficial Segfy
  comissoes?: Partial<Record<Ramo, number>>; // % por ramo
  coberturas?: {
    auto?: CoverageAuto;
    moto?: CoverageAuto;
    caminhao?: CoverageAuto;
    // residencial, vida_*, rc_profissional → próximos slices
  };
}

/**
 * Lê a config ativa do tenant (linha mais recente em `tenant_configs` ou `tenants.current_config_id`).
 * Throw quando:
 *  - Postgres não está configurado
 *  - Tenant não tem nenhuma config (não passou pelo onboarding nem foi populado por migration)
 *  - Config existe mas falta o bloco solicitado (ex: ramo auto não configurado)
 */
export async function getTenantQuoteConfig(tenantId: string): Promise<TenantQuoteConfigShape> {
  if (!isPostgresConfigured()) {
    throw new Error('Postgres não configurado — quoteConfig não pode ser lida.');
  }
  const result = await getPostgresPool().query<{ config: TenantQuoteConfigShape }>(
    `select tc.config
     from tenant_configs tc
     join tenants t on t.current_config_id = tc.id
     where t.id = $1
     limit 1`,
    [tenantId],
  );
  const config = result.rows[0]?.config;
  if (!config) {
    throw new Error(`Tenant ${tenantId} não tem configuração de cotação. Complete o onboarding antes de cotar.`);
  }
  return config;
}

export async function getTenantCoverageForRamo(
  tenantId: string,
  ramo: Extract<Ramo, 'auto' | 'moto' | 'caminhao'>,
): Promise<CoverageAuto> {
  const config = await getTenantQuoteConfig(tenantId);
  const coverage = config.coberturas?.[ramo];
  if (!coverage) {
    throw new Error(`Tenant ${tenantId} não tem cobertura configurada pro ramo "${ramo}". Complete o onboarding ou ajuste no painel.`);
  }
  return coverage;
}

export async function getTenantSeguradoras(tenantId: string): Promise<string[]> {
  const config = await getTenantQuoteConfig(tenantId);
  const seguradoras = config.seguradoras ?? [];
  if (seguradoras.length === 0) {
    throw new Error(`Tenant ${tenantId} não tem seguradoras habilitadas.`);
  }
  return seguradoras;
}

export async function getTenantComissao(tenantId: string, ramo: Ramo): Promise<number> {
  const config = await getTenantQuoteConfig(tenantId);
  const comissao = config.comissoes?.[ramo];
  if (comissao === undefined) {
    throw new Error(`Tenant ${tenantId} não tem comissão configurada pro ramo "${ramo}".`);
  }
  return comissao;
}
