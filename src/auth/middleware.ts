import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { resolveSession, SESSION_COOKIE, authConfigured } from './session.js';
import { setRequestAuthContext, type AuthContext } from './context.js';

const DEFAULT_TENANT_NAME = process.env.ROBOCOTE_TENANT_NAME?.trim() || 'Corretora Piloto RPI';

/**
 * Middleware de autenticação. Roda em toda rota /api:
 *  1. Lê cookie de sessão → resolve no Postgres → injeta AuthContext real.
 *  2. Aplica impersonation: se superadmin tem acting_as_tenant_id, o tenant efetivo
 *     vira o impersonado (mas isSuperadmin permanece true pra poder sair).
 *  3. Se não há sessão, NÃO injeta nada — resolveAuthContext cai no fallback dev,
 *     e requireAuth/requirePanelAccess barram conforme a política.
 */
export async function authMiddleware(c: Context, next: Next): Promise<void | Response> {
  if (authConfigured()) {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) {
      const session = await resolveSession(sessionId).catch(() => null);
      if (session) {
        const impersonating = session.role === 'superadmin' && session.actingAsTenantId ? session.actingAsTenantId : null;
        const effectiveTenantId = impersonating ?? session.tenantId;
        const ctx: AuthContext = {
          userId: session.userId,
          name: session.name,
          email: session.email,
          role: impersonating ? 'admin' : session.role, // ao impersonar, age como admin do tenant
          tenantId: effectiveTenantId,
          tenantName: effectiveTenantId ? DEFAULT_TENANT_NAME : null,
          isSuperadmin: session.role === 'superadmin',
          authMode: 'session',
          sessionId: session.sessionId,
          impersonatingTenantId: impersonating,
          mustChangePassword: session.mustChangePassword,
        };
        setRequestAuthContext(c, ctx);
      }
    }
  }
  await next();
}
