import type { QuoteCustomerInfo, QuoteRamo } from './summary.js';

/**
 * Cache em memória de contexto da cotação por GUID Segfy.
 * Sobrevive entre `runAutoF1Quote` (que gera o GUID) e `GET /api/cotacoes/:guid/resumo`
 * (que o Quote Room consome). Guarda customer info + tenantId pra resolver agent_name
 * dinâmico no Quote Room sem precisar de query extra, e o ramo — sem ele a sala
 * bateria no show-results de veículo pra um GUID residencial.
 *
 * Spike: in-memory com TTL 24h. Em F4 vira tabela `quote_meta` no Postgres.
 */

interface QuoteContextEntry {
  info: QuoteCustomerInfo;
  tenantId: string | null;
  ramo: QuoteRamo;
  expiresAt: number;
}

export interface QuoteContext {
  info: QuoteCustomerInfo;
  tenantId: string | null;
  ramo: QuoteRamo;
}

const CACHE = new Map<string, QuoteContextEntry>();
const TTL_MS = 1000 * 60 * 60 * 24;

export function cacheQuoteContext(
  guid: string,
  info: QuoteCustomerInfo,
  tenantId: string | null = null,
  ramo: QuoteRamo = 'auto',
): void {
  CACHE.set(guid, { info, tenantId, ramo, expiresAt: Date.now() + TTL_MS });
}

export function readQuoteContext(guid: string): QuoteContext | undefined {
  const entry = CACHE.get(guid);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    CACHE.delete(guid);
    return undefined;
  }
  return { info: entry.info, tenantId: entry.tenantId, ramo: entry.ramo };
}
