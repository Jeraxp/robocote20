import { createHash } from 'node:crypto';
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

/** Ramos que rodam no MESMO motor Segfy `vehicle` (mesmo shape de cobertura, muda só vehicle_type). */
export type VehicleRamo = 'auto' | 'moto' | 'caminhao';
export const VEHICLE_RAMOS: VehicleRamo[] = ['auto', 'moto', 'caminhao'];

/** Mapeia ramo → vehicle_type aceito pela Segfy no payload de cotação. */
export const VEHICLE_TYPE_BY_RAMO: Record<VehicleRamo, string> = {
  auto: 'car',
  moto: 'motorcycle',
  caminhao: 'truck',
};

export function isVehicleRamo(value: string): value is VehicleRamo {
  return (VEHICLE_RAMOS as string[]).includes(value);
}

/**
 * Cobertura de ramo Auto. Valores enum (franquia, tipo_cobertura, assistencia_24h, vidros,
 * carro_reserva, tipo_carro_reserva, reposicao_zero_km) DEVEM bater com os enums oficiais
 * que a Segfy NJ aceita no endpoint `/api/vehicle/version/1.0/calculate`.
 *
 * Pra evitar dupla camada de mapeamento, armazenamos os valores Segfy diretos no JSON canônico.
 * O wizard é responsável por mostrar labels amigáveis ("Compreensiva") e gravar values técnicos
 * ("comprehensive"). Ver swagger-public.json pra lista canônica de valores aceitos.
 */
/** CoverageVehicle: shape de cobertura compartilhado por auto/moto/caminhão (motor Segfy vehicle). */
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

/** Alias semântico — auto/moto/caminhão usam o mesmo shape. */
export type CoverageVehicle = CoverageAuto;

/**
 * Cobertura Residencial — DEFAULTS da corretora pro motor Segfy `residence`
 * (`/api/residence/version/1.0/calculate`, shape totalmente diferente do vehicle).
 *
 * Aqui ficam só os padrões que a corretora controla: a verba (o que está segurado),
 * o nível de assistência e os limites R$ das coberturas secundárias. Os valores
 * dependentes do lead — valor do imóvel (edificação) e do conteúdo, que também
 * definem o limite de incêndio — vêm na jornada, não no painel.
 *
 * Enums `verba` e `assistencia` batem com o swagger Segfy (sum / assistance).
 */
export interface CoverageResidencial {
  verba: string;                   // sum: 'content' | 'building' | 'building_content'
  assistencia: string;             // assistance: 'basic' | 'intermediary' | 'total'
  danos_eletricos: number;         // electrical_damages — R$
  tubulacoes: number;              // pipes (ruptura de tubulações) — R$
  pagamento_aluguel: number;       // rent_payment — R$
  quebra_vidros: number;           // glasses — R$
  recomposicao_documentos: number; // recomposition_documents — R$
  rc_familiar: number;             // family (responsabilidade civil familiar) — R$
  roubo_furto: number;             // theft — R$
  vendaval: number;                // wind (vendaval/furacão/granizo) — R$
  impacto_veiculo: number;         // vehicle_impact — R$
  danos_morais: number;            // moral_damages — R$
  desmoronamento: number;          // landslip — R$
  terremoto: number;               // earthquake — R$
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
    residencial?: CoverageResidencial;
    // vida_*, rc_profissional → próximos slices
  };
}

/** Ramos que a corretora declarou que oferece (toggle no painel). Vazio = nenhum. */
export async function getTenantActiveRamos(tenantId: string): Promise<Ramo[]> {
  const config = await getTenantQuoteConfig(tenantId);
  return config.ramos ?? [];
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

export async function getTenantCoverageResidencial(tenantId: string): Promise<CoverageResidencial> {
  const config = await getTenantQuoteConfig(tenantId);
  const coverage = config.coberturas?.residencial;
  if (!coverage) {
    throw new Error(`Tenant ${tenantId} não tem cobertura residencial configurada. Complete o onboarding ou ajuste no painel.`);
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

export type ConfigSource = 'onboarding_initial' | 'panel_edit' | 'admin_override' | 'migration' | 'rollback';

/**
 * Grava uma NOVA versão da config do tenant (insert-only em tenant_configs) e
 * atualiza tenants.current_config_id pra apontar pra ela. Histórico preservado.
 *
 * Usa transação pra garantir que o insert + update do ponteiro sejam atômicos.
 * config_hash = sha256 do JSON — permite detectar no-op (mesma config salva 2x).
 */
export async function saveTenantQuoteConfig(
  tenantId: string,
  config: TenantQuoteConfigShape,
  opts: { source: ConfigSource; changedBy?: string | null; changeNote?: string | null },
): Promise<{ configId: number; configHash: string; skipped: boolean }> {
  if (!isPostgresConfigured()) {
    throw new Error('Postgres não configurado — quoteConfig não pode ser gravada.');
  }
  const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const pool = getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query('begin');

    // No-op guard: se o hash bate com a config ativa atual, não cria nova linha.
    const current = await client.query<{ config_hash: string; id: string }>(
      `select tc.config_hash, tc.id
       from tenant_configs tc
       join tenants t on t.current_config_id = tc.id
       where t.id = $1
       limit 1`,
      [tenantId],
    );
    if (current.rows[0]?.config_hash === configHash) {
      await client.query('commit');
      return { configId: Number(current.rows[0].id), configHash, skipped: true };
    }

    const inserted = await client.query<{ id: string }>(
      `insert into tenant_configs (tenant_id, config, config_hash, source, changed_by, change_note)
       values ($1, $2::jsonb, $3, $4, $5, $6)
       returning id`,
      [tenantId, JSON.stringify(config), configHash, opts.source, opts.changedBy ?? null, opts.changeNote ?? null],
    );
    const configId = Number(inserted.rows[0].id);

    await client.query('update tenants set current_config_id = $1, updated_at = now() where id = $2', [configId, tenantId]);

    await client.query('commit');
    return { configId, configHash, skipped: false };
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
