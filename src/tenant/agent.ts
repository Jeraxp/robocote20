import { getPostgresPool, isPostgresConfigured } from '../db/postgres.js';

const DEFAULT_AGENT_NAME = 'Robocote';
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: string;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Sem Postgres (dev local, rede de testes): o nome gravado pelo painel vive aqui. */
const memoria = new Map<string, string>();

function envFallback(): string {
  return process.env.ROBOCOTE_AGENT_NAME?.trim() || DEFAULT_AGENT_NAME;
}

/**
 * Nome do agente exibido pro lead na conversa. Ordem de prioridade:
 *   1. `tenants.agent_name` (DB) — semi-white-label por corretora (Helena, Carlos, etc).
 *   2. `ROBOCOTE_AGENT_NAME` (env) — default por instalação/stack.
 *   3. `'Robocote'` — fallback final do produto.
 *
 * Cacheado por tenant com TTL de 60s pra evitar hit no DB a cada mensagem WhatsApp.
 * Pra invalidar manualmente (após editar tenant no painel), chamar `clearAgentNameCache`.
 */
export async function getAgentName(tenantId: string): Promise<string> {
  if (!isPostgresConfigured()) return memoria.get(tenantId) || envFallback();

  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const result = await getPostgresPool().query<{ agent_name: string | null }>(
      'select agent_name from tenants where id = $1 limit 1',
      [tenantId],
    );
    const dbValue = result.rows[0]?.agent_name?.trim();
    const value = dbValue || envFallback();
    cache.set(tenantId, { value, fetchedAt: Date.now() });
    return value;
  } catch {
    // DB indisponível — não trava, cai pra env
    return envFallback();
  }
}

export function clearAgentNameCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/**
 * Grava o nome do agente da corretora (edição pelo painel). Vazio/null volta ao
 * fallback (env → 'Robocote'). Invalida o cache na hora: a próxima saudação já
 * sai com o nome novo.
 */
export async function setAgentName(tenantId: string, name: string | null): Promise<void> {
  const limpo = name?.trim() || null;
  if (!isPostgresConfigured()) {
    if (limpo) memoria.set(tenantId, limpo);
    else memoria.delete(tenantId);
    clearAgentNameCache(tenantId);
    return;
  }
  await getPostgresPool().query(
    'update tenants set agent_name = $1, updated_at = now() where id = $2',
    [limpo, tenantId],
  );
  clearAgentNameCache(tenantId);
}
