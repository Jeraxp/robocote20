/**
 * Resolve QUAL CORRETORA é dona de uma mensagem de WhatsApp, pela conta em que
 * ela chegou (Fase 2 da unificação).
 *
 * Sem isto, todo lead cai num tenant padrão de variável de ambiente — com duas
 * corretoras no ar, lead de uma aparece no painel da outra. O mapa sempre
 * existiu na tabela `whatsapp_instances`; faltava consultá-lo.
 *
 * A "conta" é o identificador que cada canal entrega no webhook:
 *  - Evolution: o nome da instância (`instance`)
 *  - Meta Cloud API: o `metadata.phone_number_id` do número que recebeu
 */

import { getPostgresPool, isPostgresConfigured } from '../db/postgres.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { tenantId: string | null; expiresAt: number }>();

/** Limpa o cache — usado em teste e ao cadastrar/editar instância. */
export function clearWhatsappAccountCache(): void {
  cache.clear();
}

/**
 * Devolve o tenant dono da conta, ou null quando a conta não está cadastrada.
 * Null é resposta legítima: significa "não sei", e quem chama decide o que fazer
 * — jamais adivinhar (esse era o defeito).
 */
export async function resolveTenantForWhatsappAccount(
  accountId: string | undefined | null,
): Promise<string | null> {
  const id = accountId?.trim();
  if (!id) return null;
  if (!isPostgresConfigured()) return null;

  const hit = cache.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.tenantId;

  let tenantId: string | null = null;
  try {
    const result = await getPostgresPool().query(
      `select tenant_id from whatsapp_instances
        where evolution_instance_name = $1 or cloud_phone_number_id = $1
        limit 1`,
      [id],
    );
    const row = result.rows[0] as { tenant_id?: string } | undefined;
    tenantId = typeof row?.tenant_id === 'string' ? row.tenant_id : null;
  } catch (e) {
    // Falha de banco não pode virar "adivinha o tenant": devolve não-sei.
    console.warn(`[tenant] falha ao resolver conta de WhatsApp "${id}": ${(e as Error).message}`);
    return null;
  }

  cache.set(id, { tenantId, expiresAt: Date.now() + CACHE_TTL_MS });
  return tenantId;
}
