/**
 * Webchat embutido no site da corretora — rotas públicas e de configuração.
 *
 * Duas plateias, dois níveis de guarda:
 *  - PÚBLICA (`/api/webchat/identidade`): qualquer visitante do site da corretora.
 *    Devolve só o que a tela precisa antes da primeira fala — nome do agente,
 *    avatar, cor, saudação. Nada de dado de negócio. Corretora inexistente,
 *    inativa ou com o canal desligado responde 404 "canal indisponível": não se
 *    revela o motivo, e link sem dono não atende ninguém.
 *  - PAINEL (`/api/painel/config/webchat`, `/api/painel/webchat/instalacao`):
 *    exige acesso ao painel e respeita o escopo da corretora. O nome do agente
 *    vai pra coluna `tenants.agent_name` (que o WhatsApp, a IA e a sala de
 *    cotação já leem); o resto vai pro JSON versionado da corretora.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import {
  getWebchatIdentidade,
  resolveWebchatTenant,
  readWebchatConfig,
  saveWebchatConfig,
  webchatConfigSchema,
  clearWebchatCache,
} from '../tenant/webchat.js';
import { origemPermitida } from '../tenant/webchat.js';
import { getAgentName, setAgentName } from '../tenant/agent.js';
import { limitarPorIp } from '../middleware/limites.js';
import { requirePanelAccess, resolveAuthContext, resolveConfigTenantId } from './painelAcesso.js';

export const webchat = new Hono();

/**
 * Rotas do painel montadas em `/api/painel` — os dois caminhos que a tela usa
 * (`/config/webchat` e `/webchat/instalacao`) vivem sob prefixos diferentes.
 */
export const webchatPainel = new Hono();

/** Corretora pedida na URL pública. */
function refDoPedido(c: Context): string | undefined {
  return c.req.query('tenant')?.trim() || undefined;
}

// ─── Pública: o que a tela precisa antes da primeira fala ───────────────────

// Rota pública e barata, mas ainda assim pública: sem teto, um dicionário de
// slugs mapeia a carteira inteira de corretoras em segundos.
webchat.use('/identidade', limitarPorIp);

webchat.get('/identidade', async (c) => {
  const tenant = await resolveWebchatTenant(refDoPedido(c));
  const origem = c.req.header('origin') || c.req.header('referer');
  if (!tenant || !origemPermitida(tenant.config, origem)) {
    return c.json({ ok: false, error: 'canal indisponível' }, 404);
  }
  const identidade = await getWebchatIdentidade(tenant);
  // O loader roda no site da corretora — outra origem. Dado 100% público.
  c.header('Access-Control-Allow-Origin', '*');
  // Sem cache: o corretor troca a cor no painel e quer ver na hora. A resposta
  // é minúscula; guardar 60s só criaria a dúvida "salvou ou não?".
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, ...identidade });
});

webchat.options('/identidade', (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'content-type');
  return c.body(null, 204);
});

// ─── Painel: identidade e instalação ────────────────────────────────────────

/**
 * Configuração da corretora é coisa de gestor. A navegação já escondia do
 * operador; esconder na tela e deixar a rota aberta é guarda de fachada.
 */
function exigirGestor(c: Context): Response | null {
  const negado = requirePanelAccess(c);
  if (negado) return negado;
  const auth = resolveAuthContext(c);
  if (auth.role === 'operador') {
    return c.json({ ok: false, error: 'seu perfil não altera a configuração do webchat' }, 403);
  }
  return null;
}

const putSchema = z.object({
  tenantId: z.string().optional(),
  agentName: z.string().trim().min(1, 'nome do agente é obrigatório').max(60),
  webchat: webchatConfigSchema,
});

webchatPainel.get('/config/webchat', async (c) => {
  const denied = exigirGestor(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  const tenantId = resolveConfigTenantId(c, auth);
  if (!tenantId) {
    return c.json({ ok: false, error: 'tenantId obrigatório (superadmin: passe ?tenantId=)' }, 400);
  }
  return c.json({
    ok: true,
    tenantId,
    agentName: await getAgentName(tenantId),
    webchat: await readWebchatConfig(tenantId),
  });
});

webchatPainel.put('/config/webchat', async (c) => {
  const denied = exigirGestor(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  const raw = await c.req.json().catch(() => null) as { tenantId?: string } | null;
  const tenantId = resolveConfigTenantId(c, auth, raw?.tenantId);
  if (!tenantId) {
    return c.json({ ok: false, error: 'tenantId obrigatório (superadmin: passe tenantId no corpo)' }, 400);
  }

  const parsed = putSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'payload inválido',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }

  try {
    // Duas casas por um motivo: o nome do agente é identidade do produto inteiro
    // (WhatsApp, IA, sala de cotação leem a coluna); o resto é só do webchat.
    // A config vai PRIMEIRO: ela é versionada (dá pra ver e voltar). Se o nome
    // falhar depois, o painel diz que não salvou e o nome antigo continua
    // valendo em todos os canais — o oposto deixaria o agente renomeado por um
    // salvamento que a tela declarou fracassado.
    await saveWebchatConfig(tenantId, parsed.data.webchat, {
      changedBy: auth.userId ?? undefined,
    });
    await setAgentName(tenantId, parsed.data.agentName);
    clearWebchatCache(tenantId);
    return c.json({
      ok: true,
      tenantId,
      agentName: parsed.data.agentName,
      webchat: parsed.data.webchat,
    });
  } catch (e) {
    console.error(`[webchat] falha ao salvar config de ${tenantId}: ${(e as Error).message}`);
    return c.json({ ok: false, error: 'não consegui salvar a configuração agora' }, 500);
  }
});

/**
 * De onde o site da corretora vai chamar o Robocote. Preferimos a env pública
 * (o endereço que o cliente enxerga) e só caímos na origem do pedido em dev —
 * um snippet com `localhost` colado no site do cliente não carrega nada.
 */
function baseUrlPublica(c: Context): string {
  const env = (process.env.ROBOCOTE_PUBLIC_URL || process.env.ROBOCOTE_QUOTE_BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  try {
    return new URL(c.req.url).origin;
  } catch {
    return '';
  }
}

webchatPainel.get('/webchat/instalacao', async (c) => {
  const denied = exigirGestor(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  const tenantId = resolveConfigTenantId(c, auth);
  if (!tenantId) {
    return c.json({ ok: false, error: 'tenantId obrigatório (superadmin: passe ?tenantId=)' }, 400);
  }

  const baseUrl = baseUrlPublica(c);
  // O slug é gerado por slugify (só [a-z0-9-]) — cabe em atributo e em URL sem escape extra.
  const slug = tenantId;
  return c.json({
    ok: true,
    tenantId,
    slug,
    baseUrl,
    snippets: {
      bubble: `<script src="${baseUrl}/webchat.js" data-tenant="${slug}" async></script>`,
      iframe: `<iframe src="${baseUrl}/webchat?tenant=${slug}" style="width:100%;height:640px;border:0;border-radius:16px" title="Atendimento"></iframe>`,
    },
  });
});
