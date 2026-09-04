/**
 * Webchat por corretora — quem pode embutir, com que cara, e se está ligado.
 *
 * A identidade pública (nome do agente, avatar, cor, saudação) é o que o site da
 * corretora mostra ao lead; `ativo` e `allowedOrigins` são os guard-rails do canal.
 * O nome do agente continua na coluna `tenants.agent_name` (WhatsApp, IA e Quote
 * Room já dependem dela); o resto mora no JSON versionado de `tenant_configs`.
 *
 * Sem Postgres (dev local e rede de testes) tudo vive em memória — o painel e o
 * widget funcionam igual, só não sobrevivem ao restart.
 */

import { z } from 'zod';
import { getPostgresPool, isPostgresConfigured } from '../db/postgres.js';
import { adminStore, type TenantRecord } from '../admin/store.js';
import type { AuthContext } from '../auth/context.js';
import { getAgentName } from './agent.js';
import type { WebchatConfigShape } from './quoteConfig.js';

export type WebchatConfig = WebchatConfigShape;

export const WEBCHAT_DEFAULTS: WebchatConfig = {
  ativo: true,
  avatarUrl: null,
  cor: '#0aa5e8',
  saudacao: null,
  allowedOrigins: [],
};

const COR_HEX = /^#[0-9a-f]{6}$/i;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
/** Referência pública da corretora no link (slug ou id) — só o que `slugify` produz. */
const REF_TENANT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CACHE_TTL_MS = 60_000;

/**
 * Host a partir do que a corretora digitou: aceita "https://site.com.br/pagina",
 * "site.com.br" ou "SITE.com.br:8443". Devolve null se não dá pra extrair host.
 */
export function normalizarHost(valor: string): string | null {
  const bruto = valor.trim().toLowerCase();
  if (!bruto) return null;
  try {
    const url = new URL(bruto.includes('://') ? bruto : `https://${bruto}`);
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    return HOST.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Zod do bloco webchat como o painel envia — o PUT valida com isto. */
export const webchatConfigSchema = z.object({
  ativo: z.boolean(),
  avatarUrl: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(2000).url().nullable(),
  ),
  cor: z.string().trim().regex(COR_HEX, 'cor deve ser hex #rrggbb'),
  saudacao: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(300).nullable(),
  ),
  allowedOrigins: z.array(z.string().trim().min(1).max(253)).max(20)
    .transform((lista) => {
      const hosts = lista.map(normalizarHost).filter((h): h is string => Boolean(h));
      return [...new Set(hosts)];
    }),
});

/** Leitura tolerante: JSON antigo/parcial vira config completa com defaults. */
export function normalizarWebchatConfig(raw: unknown): WebchatConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof WebchatConfig, unknown>>;
  const cor = typeof r.cor === 'string' && COR_HEX.test(r.cor.trim()) ? r.cor.trim().toLowerCase() : WEBCHAT_DEFAULTS.cor;
  const avatarUrl = typeof r.avatarUrl === 'string' && r.avatarUrl.trim() ? r.avatarUrl.trim() : null;
  const saudacao = typeof r.saudacao === 'string' && r.saudacao.trim() ? r.saudacao.trim().slice(0, 300) : null;
  const allowedOrigins = Array.isArray(r.allowedOrigins)
    ? r.allowedOrigins
      .filter((h): h is string => typeof h === 'string')
      .map(normalizarHost)
      .filter((h): h is string => Boolean(h))
      .slice(0, 20)
    : [];
  return {
    ativo: typeof r.ativo === 'boolean' ? r.ativo : WEBCHAT_DEFAULTS.ativo,
    avatarUrl,
    cor,
    saudacao,
    allowedOrigins: [...new Set(allowedOrigins)],
  };
}

export interface WebchatTenant {
  tenantId: string;
  slug: string;
  nome: string;
  config: WebchatConfig;
}

export interface WebchatIdentidade {
  tenantId: string;
  agentName: string;
  avatarUrl: string | null;
  cor: string;
  saudacao: string | null;
}

// ─── Persistência da config ─────────────────────────────────────────────────

/** Sem Postgres: o que o painel gravou vive aqui. */
const memoriaConfig = new Map<string, WebchatConfig>();

interface CacheEntry {
  value: WebchatTenant | null;
  fetchedAt: number;
}
const cacheTenant = new Map<string, CacheEntry>();

/**
 * O cache é alimentado por rota PÚBLICA: qualquer string no formato de slug vira
 * uma entrada (inclusive as negativas). Sem poda, um script derruba o processo
 * por memória. Expira o que venceu e, no pior caso, corta o mais antigo.
 */
const CACHE_TETO = 500;

function podarCache(): void {
  const agora = Date.now();
  for (const [chave, entrada] of cacheTenant) {
    if (agora - entrada.fetchedAt > CACHE_TTL_MS) cacheTenant.delete(chave);
  }
  while (cacheTenant.size >= CACHE_TETO) {
    const maisAntiga = cacheTenant.keys().next().value;
    if (maisAntiga === undefined) break;
    cacheTenant.delete(maisAntiga);
  }
}

export function clearWebchatCache(tenantId?: string): void {
  if (!tenantId) {
    cacheTenant.clear();
    return;
  }
  for (const [chave, entrada] of cacheTenant) {
    if (entrada.value?.tenantId === tenantId || chave === tenantId) cacheTenant.delete(chave);
  }
}

/**
 * Config do webchat da corretora, sempre completa (defaults por cima do que
 * está gravado). Tenant sem config nenhuma (antes do onboarding) = defaults:
 * o canal nasce ligado com a cara padrão do produto.
 *
 * O import é dinâmico de propósito: a rede de testes dubla `quoteConfig.js`
 * com um subconjunto de exports, e um import estático de nome ausente derruba
 * o processo no link. Sem Postgres esse caminho nunca roda.
 */
export async function readWebchatConfig(tenantId: string): Promise<WebchatConfig> {
  if (!isPostgresConfigured()) {
    return memoriaConfig.get(tenantId) ?? { ...WEBCHAT_DEFAULTS };
  }
  try {
    const quoteConfig = await import('./quoteConfig.js');
    const bloco = await quoteConfig.getTenantWebchatConfig(tenantId);
    return normalizarWebchatConfig(bloco);
  } catch {
    return { ...WEBCHAT_DEFAULTS };
  }
}

/**
 * Grava o bloco webchat como NOVA versão da config da corretora (insert-only,
 * source 'panel_edit' — o rastro é a própria linha em tenant_configs).
 */
export async function saveWebchatConfig(
  tenantId: string,
  config: WebchatConfig,
  opts: { changedBy?: string | null },
): Promise<void> {
  const limpo = normalizarWebchatConfig(config);
  if (!isPostgresConfigured()) {
    memoriaConfig.set(tenantId, limpo);
    clearWebchatCache(tenantId);
    return;
  }
  const quoteConfig = await import('./quoteConfig.js');
  let atual: import('./quoteConfig.js').TenantQuoteConfigShape;
  try {
    atual = await quoteConfig.getTenantQuoteConfig(tenantId);
  } catch {
    atual = { version: '2.0', plano: 'seguros', ramos: [] };
  }
  await quoteConfig.saveTenantQuoteConfig(
    tenantId,
    { ...atual, version: atual.version ?? '2.0', webchat: limpo },
    { source: 'panel_edit', changedBy: opts.changedBy ?? null, changeNote: 'Edição do webchat via painel' },
  );
  clearWebchatCache(tenantId);
}

// ─── Resolução da corretora pelo link público ───────────────────────────────

const AUTH_SISTEMA: AuthContext = {
  userId: 'sistema',
  name: 'Sistema',
  email: 'sistema@local',
  role: 'superadmin',
  tenantId: null,
  tenantName: null,
  isSuperadmin: true,
  authMode: 'dev',
};

async function buscarTenant(ref: string): Promise<Pick<TenantRecord, 'id' | 'slug' | 'name' | 'status'> | null> {
  if (!isPostgresConfigured()) {
    const lista = await adminStore.listTenants(AUTH_SISTEMA);
    return lista.find((t) => t.id === ref || t.slug === ref) ?? null;
  }
  const r = await getPostgresPool().query<{ id: string; slug: string; name: string; status: TenantRecord['status'] }>(
    'select id, slug, name, status from tenants where id = $1 or slug = $1 limit 1',
    [ref],
  );
  return r.rows[0] ?? null;
}

/**
 * Corretora dona do link público. null quando: referência malformada, tenant
 * não existe, tenant não está `active`, ou (com `exigirAtivo`) o webchat foi
 * desligado no painel. Jamais adivinha — link sem dono não atende ninguém.
 */
export async function resolveWebchatTenant(
  ref: string | undefined | null,
  opts: { exigirAtivo?: boolean } = {},
): Promise<WebchatTenant | null> {
  const chave = ref?.trim().toLowerCase() ?? '';
  if (!REF_TENANT.test(chave)) return null;

  const cached = cacheTenant.get(chave);
  let tenant: WebchatTenant | null;
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    tenant = cached.value;
  } else {
    let registro: Awaited<ReturnType<typeof buscarTenant>> = null;
    try {
      registro = await buscarTenant(chave);
    } catch (e) {
      console.error(`[webchat] falha ao resolver corretora "${chave}": ${(e as Error).message}`);
      return null; // DB fora: não cacheia a falha, tenta de novo no próximo pedido
    }
    tenant = registro && registro.status === 'active'
      ? { tenantId: registro.id, slug: registro.slug, nome: registro.name, config: await readWebchatConfig(registro.id) }
      : null;
    podarCache();
    cacheTenant.set(chave, { value: tenant, fetchedAt: Date.now() });
  }

  if (!tenant) return null;
  if ((opts.exigirAtivo ?? true) && !tenant.config.ativo) return null;
  return tenant;
}

/** O que o widget e o loader precisam saber antes da primeira fala. */
export async function getWebchatIdentidade(tenant: WebchatTenant): Promise<WebchatIdentidade> {
  return {
    tenantId: tenant.tenantId,
    agentName: await getAgentName(tenant.tenantId),
    avatarUrl: tenant.config.avatarUrl,
    cor: tenant.config.cor,
    saudacao: tenant.config.saudacao,
  };
}

/**
 * O site que embute tem permissão? Lista vazia = qualquer um (é o default e a
 * tela diz isso). Comparação por HOST: o corretor digita "corretora.com.br" e
 * espera que valha para http/https e para qualquer caminho.
 *
 * `www.` é ignorado dos dois lados — ninguém entende por que o chat funciona em
 * um e falha no outro. Subdomínio declarado vale para si e para os seus filhos.
 */
export function origemPermitida(config: WebchatConfig, origem: string | undefined | null): boolean {
  const permitidos = config.allowedOrigins ?? [];
  if (permitidos.length === 0) return true;
  const host = hostDe(origem);
  if (!host) return false;
  return permitidos.some((p) => {
    const alvo = normalizarHost(p);
    if (!alvo) return false;
    return host === alvo || host.endsWith(`.${alvo}`);
  });
}

function hostDe(valor: string | undefined | null): string | null {
  const bruto = valor?.trim();
  if (!bruto) return null;
  try {
    return normalizarHost(new URL(bruto).host);
  } catch {
    return normalizarHost(bruto);
  }
}

/** Só pra testes: esquece tudo que foi gravado em memória. */
export function resetWebchatMemoria(): void {
  memoriaConfig.clear();
  cacheTenant.clear();
}
