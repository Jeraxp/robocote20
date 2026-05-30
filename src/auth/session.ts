import { randomBytes } from 'node:crypto';
import { getPostgresPool, isPostgresConfigured } from '../db/postgres.js';

/**
 * Sessões server-side de autenticação. Cookie httpOnly carrega apenas o id opaco;
 * tudo mais vive no Postgres (auth_sessions). Permite revogação imediata e
 * impersonation (acting_as_tenant_id).
 */

export const SESSION_COOKIE = 'rbc_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const TOUCH_THROTTLE_MS = 5 * 60 * 1000; // só atualiza last_seen_at a cada 5min

export interface SessionRow {
  id: string;
  userId: string;
  actingAsTenantId: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface SessionUser {
  userId: string;
  name: string;
  email: string;
  role: 'superadmin' | 'admin' | 'operador';
  tenantId: string | null;
  mustChangePassword: boolean;
}

/** Resolve usuário + papel a partir do email (login). Retorna null se não existe/inativo. */
export async function findUserForLogin(email: string): Promise<(SessionUser & { passwordHash: string | null }) | null> {
  const result = await getPostgresPool().query<{
    id: string;
    name: string;
    email: string;
    password_hash: string | null;
    status: string;
    must_change_password: boolean;
    is_superadmin: boolean;
    tenant_id: string | null;
    role: string | null;
  }>(
    `select u.id, u.name, u.email, u.password_hash, u.status, u.must_change_password,
            (sa.user_id is not null) as is_superadmin,
            tm.tenant_id, tm.role
     from users u
     left join superadmin_users sa on sa.user_id = u.id
     left join tenant_memberships tm on tm.user_id = u.id
     where lower(u.email) = lower($1)
     limit 1`,
    [email.trim()],
  );
  const row = result.rows[0];
  if (!row || row.status !== 'active') return null;
  const role: SessionUser['role'] = row.is_superadmin ? 'superadmin' : (row.role === 'admin' ? 'admin' : 'operador');
  return {
    userId: row.id,
    name: row.name,
    email: row.email,
    role,
    tenantId: row.tenant_id,
    mustChangePassword: row.must_change_password,
    passwordHash: row.password_hash,
  };
}

export async function createSession(userId: string, meta: { ip?: string; userAgent?: string } = {}): Promise<string> {
  const id = randomBytes(32).toString('hex');
  const now = Date.now();
  await getPostgresPool().query(
    `insert into auth_sessions (id, user_id, ip, user_agent, created_at, last_seen_at, expires_at)
     values ($1, $2, $3, $4, $5, $5, $6)`,
    [id, userId, meta.ip ?? null, meta.userAgent ?? null, new Date(now), new Date(now + SESSION_TTL_MS)],
  );
  return id;
}

/** Busca sessão válida (não expirada) + dados do usuário. Atualiza last_seen_at com throttle. */
export async function resolveSession(sessionId: string): Promise<(SessionUser & { sessionId: string; actingAsTenantId: string | null }) | null> {
  if (!sessionId) return null;
  const result = await getPostgresPool().query<{
    session_id: string;
    acting_as_tenant_id: string | null;
    last_seen_at: Date;
    user_id: string;
    name: string;
    email: string;
    status: string;
    must_change_password: boolean;
    is_superadmin: boolean;
    tenant_id: string | null;
    role: string | null;
  }>(
    `select s.id as session_id, s.acting_as_tenant_id, s.last_seen_at,
            u.id as user_id, u.name, u.email, u.status, u.must_change_password,
            (sa.user_id is not null) as is_superadmin,
            tm.tenant_id, tm.role
     from auth_sessions s
     join users u on u.id = s.user_id
     left join superadmin_users sa on sa.user_id = u.id
     left join tenant_memberships tm on tm.user_id = u.id
     where s.id = $1 and s.expires_at > now()
     limit 1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row || row.status !== 'active') return null;

  // throttle touch
  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_THROTTLE_MS) {
    await getPostgresPool().query('update auth_sessions set last_seen_at = now() where id = $1', [sessionId]).catch(() => undefined);
  }

  const role: SessionUser['role'] = row.is_superadmin ? 'superadmin' : (row.role === 'admin' ? 'admin' : 'operador');
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role,
    tenantId: row.tenant_id,
    mustChangePassword: row.must_change_password,
    actingAsTenantId: row.acting_as_tenant_id,
  };
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await getPostgresPool().query('delete from auth_sessions where id = $1', [sessionId]);
}

/** Impersonation: superadmin "vira" um tenant. Passar null pra encerrar. */
export async function setSessionImpersonation(sessionId: string, tenantId: string | null): Promise<void> {
  await getPostgresPool().query('update auth_sessions set acting_as_tenant_id = $1 where id = $2', [tenantId, sessionId]);
}

export function authConfigured(): boolean {
  return isPostgresConfigured();
}
