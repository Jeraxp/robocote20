/**
 * Guardas de acesso ao painel — uma regra só, para todas as rotas.
 *
 * Estavam privadas em `routes/api.ts`. Extraídas quando o webchat ganhou rotas
 * próprias: regra de acesso duplicada é regra que diverge, e a divergência
 * aparece como buraco de permissão meses depois.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { resolveAuthContext } from '../auth/context.js';

const TOKEN_AUTH_DISABLED = process.env.ROBOCOTE_DISABLE_TOKEN_AUTH === '1';

function secureTokenEquals(candidate: string, expected: string): boolean {
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function readPanelToken(c: Context): string {
  const header = c.req.header('x-robocote-panel-token');
  if (header?.trim()) return header.trim();
  const authorization = c.req.header('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return '';
}

export function requirePanelAccess(c: Context): Response | null {
  // 1. Sessão real (login) injetada pelo authMiddleware — caminho normal.
  const auth = resolveAuthContext(c);
  if (auth.authMode === 'session') return null;

  // 2. Fallback dev/local: token de painel (a menos que explicitamente desabilitado).
  if (!TOKEN_AUTH_DISABLED) {
    const expected = process.env.ROBOCOTE_PANEL_TOKEN?.trim();
    if (!expected) return null; // sem token configurado = alpha aberto (dev local)
    const token = readPanelToken(c);
    if (token && secureTokenEquals(token, expected)) return null;
  }

  return c.json({
    ok: false,
    authRequired: true,
    error: 'acesso ao painel requer login',
  }, 401);
}

/**
 * Corretora que a edição vai afetar. Admin e operador ficam SEMPRE na própria,
 * mesmo mandando outra no corpo; só o superadmin sem corretora escolhe.
 */
export function resolveConfigTenantId(
  c: Context,
  auth: ReturnType<typeof resolveAuthContext>,
  bodyTenantId?: string,
): string {
  return auth.tenantId ?? (auth.isSuperadmin ? (c.req.query('tenantId') ?? bodyTenantId ?? '') : '');
}

export { resolveAuthContext };
