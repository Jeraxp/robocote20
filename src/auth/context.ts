import type { Context } from 'hono';

export type UserRole = 'superadmin' | 'admin' | 'operador';

export interface AuthContext {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  tenantId: string | null;
  tenantName: string | null;
  isSuperadmin: boolean;
  authMode: 'dev' | 'session';
  /** Sessão real (auth_sessions.id) quando autenticado por login; null em modo dev. */
  sessionId?: string | null;
  /** Quando superadmin está impersonando uma corretora, o tenant real assumido. */
  impersonatingTenantId?: string | null;
  /** Indica que o usuário precisa trocar a senha temporária antes de usar o painel. */
  mustChangePassword?: boolean;
}

const DEFAULT_TENANT_ID = process.env.ROBOCOTE_TENANT_ID?.trim() || 'rpi';
const DEFAULT_TENANT_NAME = process.env.ROBOCOTE_TENANT_NAME?.trim() || 'Corretora Piloto RPI';

function normalizeRole(value: string | null | undefined): UserRole {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'superadmin' || normalized === 'admin' || normalized === 'operador') return normalized;
  return 'superadmin';
}

function headerOrEnv(c: Context, header: string, env: string, fallback: string): string {
  return c.req.header(header)?.trim() || process.env[env]?.trim() || fallback;
}

const AUTH_CONTEXT_KEY = 'robocoteAuthContext';

/**
 * Injeta o AuthContext resolvido (pelo authMiddleware via sessão real) no request.
 * Chamado uma vez por request no middleware.
 */
export function setRequestAuthContext(c: Context, ctx: AuthContext): void {
  c.set(AUTH_CONTEXT_KEY, ctx);
}

/**
 * Identidade da requisição.
 *
 * 1. Se o authMiddleware resolveu uma sessão real (login), usa ela — incluindo
 *    impersonation (superadmin "vira" um tenant).
 * 2. Fallback DEV: headers internos / env. Só vale quando ROBOCOTE_DEV_AUTH=1 OU
 *    não há Postgres (spike local). Em produção com login ativo, sem sessão = sem acesso.
 */
export function resolveAuthContext(c: Context): AuthContext {
  const fromSession = c.get(AUTH_CONTEXT_KEY) as AuthContext | undefined;
  if (fromSession) return fromSession;
  return devAuthContext(c);
}

/** Contexto de desenvolvimento via headers/env — sem login real. */
export function devAuthContext(c: Context): AuthContext {
  const role = normalizeRole(c.req.header('x-robocote-role') || process.env.ROBOCOTE_DEV_ROLE);
  const tenantHeader = c.req.header('x-robocote-tenant-id')?.trim();
  const tenantId = role === 'superadmin'
    ? (tenantHeader && tenantHeader !== 'all' ? tenantHeader : null)
    : (tenantHeader || process.env.ROBOCOTE_DEV_TENANT_ID?.trim() || DEFAULT_TENANT_ID);

  return {
    userId: headerOrEnv(c, 'x-robocote-user-id', 'ROBOCOTE_DEV_USER_ID', role === 'superadmin' ? 'taskdun-superadmin' : `${tenantId}-user`),
    name: headerOrEnv(c, 'x-robocote-user-name', 'ROBOCOTE_DEV_USER_NAME', role === 'superadmin' ? 'Taskdun Superadmin' : 'Operador Robocote'),
    email: headerOrEnv(c, 'x-robocote-user-email', 'ROBOCOTE_DEV_USER_EMAIL', role === 'superadmin' ? 'admin@taskdun.com.br' : `operador@${tenantId}.local`),
    role,
    tenantId,
    tenantName: tenantId ? DEFAULT_TENANT_NAME : null,
    isSuperadmin: role === 'superadmin',
    authMode: 'dev',
  };
}

export function canManageUsers(auth: AuthContext): boolean {
  return auth.role === 'superadmin' || auth.role === 'admin';
}

export function canManageWhatsapp(auth: AuthContext): boolean {
  return auth.role === 'superadmin' || auth.role === 'admin';
}

export function canAccessTenant(auth: AuthContext, tenantId: string): boolean {
  return auth.isSuperadmin || auth.tenantId === tenantId;
}

export function tenantScope(auth: AuthContext): { tenantId?: string } {
  if (auth.isSuperadmin && !auth.tenantId) return {};
  return { tenantId: auth.tenantId ?? DEFAULT_TENANT_ID };
}

export function writableTenantId(auth: AuthContext, requestedTenantId?: string | null): string {
  const target = requestedTenantId?.trim() || auth.tenantId || DEFAULT_TENANT_ID;
  if (!canAccessTenant(auth, target)) {
    throw new Error('tenant fora do escopo do usuário');
  }
  return target;
}
