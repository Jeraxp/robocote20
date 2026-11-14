/**
 * Dublê do Postgres para as rotas de administração e de login.
 *
 * Interpreta, por prefixo, só as consultas que o store de admin
 * (`src/admin/store.ts`) e o login (`src/auth/session.ts`) fazem, e guarda as
 * linhas em memória. Consulta desconhecida LANÇA: se o código passar a mandar
 * SQL novo, o teste quebra em vez de fingir que o banco aceitou.
 *
 * Uso: `instalarBancoAdmin(banco)` no corpo do arquivo de teste, antes de
 * qualquer `await import` de `src/` (mesma regra 1 de mocks.ts). Com ele,
 * `isPostgresConfigured()` é true: o `adminStore` vira o do Postgres e o login
 * fica disponível.
 */

import { mock } from 'node:test';

export type Linha = Record<string, unknown>;
type Resultado = { rows: Linha[]; rowCount: number };
type Exec = (sql: string, params?: unknown[]) => Promise<Resultado>;

export interface BancoAdmin {
  pool: { query: Exec; connect: () => Promise<{ query: Exec; release: () => void }> };
  users: Map<string, Linha>;
  supers: Set<string>;
  /** Chave `${user_id}|${tenant_id}`. */
  memberships: Map<string, Linha>;
  tenants: Map<string, Linha>;
  sessions: Map<string, Linha>;
  /** Linhas gravadas em audit_events (na ordem). */
  auditoria: Linha[];
  consultas: Array<{ sql: string; params: unknown[] }>;
}

function normalizar(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function criarBancoAdmin(): BancoAdmin {
  const users = new Map<string, Linha>();
  const supers = new Set<string>();
  const memberships = new Map<string, Linha>();
  const tenants = new Map<string, Linha>();
  const sessions = new Map<string, Linha>();
  const auditoria: Linha[] = [];
  const consultas: Array<{ sql: string; params: unknown[] }> = [];

  const ok = (rows: Linha[]): Resultado => ({ rows, rowCount: rows.length });
  const porEmail = (email: unknown) => [...users.values()].find((u) => u.email === email);
  const comVinculo = (m: Linha): Linha => ({ ...users.get(String(m.user_id)), role: m.role, tenant_id: m.tenant_id });
  const porNome = (a: Linha, b: Linha) => String(a.name).localeCompare(String(b.name));

  const exec: Exec = async (sql, p = []) => {
    consultas.push({ sql, params: p });
    const q = normalizar(sql);
    const agora = new Date();

    if (q === 'begin' || q === 'commit' || q === 'rollback') return ok([]);

    // ─── corretoras ─────────────────────────────────────────────────────────
    if (q.startsWith('select 1 from tenants where id = $1')) {
      return ok(tenants.has(String(p[0])) ? [{}] : []);
    }
    if (q.startsWith('insert into tenants')) {
      const row: Linha = {
        id: p[0], slug: p[0], name: p[1], document_type: p[2], document: p[3],
        document_digits: p[4], phone: p[5], status: 'active', created_at: agora, updated_at: agora,
      };
      tenants.set(String(p[0]), row);
      return ok([row]);
    }

    // ─── usuários ───────────────────────────────────────────────────────────
    if (q.startsWith('select * from users where email = $1')) {
      return ok([...users.values()].filter((u) => u.email === p[0]));
    }
    if (q.startsWith('select 1 from superadmin_users where user_id = $1')) {
      return ok(supers.has(String(p[0])) ? [{}] : []);
    }
    if (q.startsWith('insert into users') && q.includes('on conflict (email) do nothing')) {
      if (porEmail(p[2])) return ok([]);
      const row: Linha = {
        id: p[0], name: p[1], email: p[2], phone: p[3], status: p[4],
        password_hash: p[5], must_change_password: p[6], created_at: agora, updated_at: agora,
      };
      users.set(String(p[0]), row);
      return ok([row]);
    }
    if (q.startsWith('insert into users') && q.includes("'invited'") && q.includes('on conflict (email) do update')) {
      // createTenantWithManager: o gestor nasce convidado e sem senha.
      const atual = porEmail(p[2]);
      if (atual) {
        atual.name = p[1];
        atual.phone = p[3];
        if (atual.status === 'disabled') atual.status = 'invited';
        atual.updated_at = agora;
        return ok([atual]);
      }
      const row: Linha = {
        id: p[0], name: p[1], email: p[2], phone: p[3], status: 'invited',
        password_hash: null, must_change_password: false, created_at: agora, updated_at: agora,
      };
      users.set(String(p[0]), row);
      return ok([row]);
    }
    if (q.startsWith("update users set password_hash = $2, status = 'active', must_change_password = true")
      && q.includes('where id = $1 and password_hash is null')) {
      // Senha inicial de quem ainda não tem senha (createUser, caso d).
      const u = users.get(String(p[0]));
      if (!u || u.password_hash) return ok([]);
      Object.assign(u, { password_hash: p[1], status: 'active', must_change_password: true, updated_at: agora });
      return ok([u]);
    }

    // ─── redefinir senha (resetUserPassword) ───────────────────────────────
    if (q.startsWith('select id, status from users where id = $1') && q.endsWith('for update')) {
      const u = users.get(String(p[0]));
      return ok(u ? [{ id: u.id, status: u.status }] : []);
    }
    if (q === 'select tenant_id, role from tenant_memberships where user_id = $1') {
      return ok([...memberships.values()].filter((m) => m.user_id === p[0]).map((m) => ({ tenant_id: m.tenant_id, role: m.role })));
    }
    if (q.startsWith('update users set password_hash = $2, must_change_password = true,')) {
      const u = users.get(String(p[0]));
      if (!u) return ok([]);
      // Status: convidado vira ativo; nada além disso (o SQL real diz o mesmo com `case`).
      const ativaConvidado = q.includes("status = case when status = 'invited' then 'active' else status end");
      const recusaDesativado = q.includes("and status <> 'disabled'");
      if (recusaDesativado && u.status === 'disabled') return ok([]);
      Object.assign(u, {
        password_hash: p[1],
        must_change_password: true,
        status: ativaConvidado && u.status === 'invited' ? 'active' : u.status,
        updated_at: agora,
      });
      return ok([u]);
    }
    if (q === 'delete from auth_sessions where user_id = $1') {
      let n = 0;
      for (const [id, s] of sessions) if (s.user_id === p[0]) { sessions.delete(id); n += 1; }
      return { rows: [], rowCount: n };
    }

    // ─── vínculos e auditoria ───────────────────────────────────────────────
    if (q.startsWith('insert into tenant_memberships')) {
      // createUser manda o papel em $3; createTenantWithManager usa 'admin' literal.
      const role = p.length >= 3 ? p[2] : 'admin';
      memberships.set(`${p[0]}|${p[1]}`, { user_id: p[0], tenant_id: p[1], role });
      return ok([]);
    }
    if (q.startsWith('insert into audit_events')) {
      // Forma com 6 parâmetros (tenant, ator, ação, tipo, id, metadata); as outras
      // (ação literal no SQL) ficam guardadas como vieram.
      auditoria.push(p.length === 6 && q.includes('values ($1, $2, $3, $4, $5, $6::jsonb)')
        ? { tenant_id: p[0], actor_user_id: p[1], action: p[2], entity_type: p[3], entity_id: p[4], metadata: JSON.parse(String(p[5])) }
        : { sql: q, params: p });
      return ok([]);
    }

    // ─── listagem de usuários ───────────────────────────────────────────────
    if (q.startsWith('select u.*, tm.role, tm.tenant_id from users u join tenant_memberships tm')
      && q.includes('where tm.tenant_id = $1')) {
      return ok([...memberships.values()].filter((m) => m.tenant_id === p[0]).map(comVinculo).sort(porNome));
    }
    if (q.startsWith("select u.*, 'superadmin' as role")) {
      const deSuper = [...supers].map((id) => ({ ...users.get(id), role: 'superadmin', tenant_id: null }));
      return ok([...deSuper, ...[...memberships.values()].map(comVinculo)].sort(porNome));
    }

    // ─── login e sessão ─────────────────────────────────────────────────────
    if (q.startsWith('select u.id, u.name, u.email, u.password_hash') && q.includes('where lower(u.email) = lower($1)')) {
      const u = [...users.values()].find((x) => String(x.email).toLowerCase() === String(p[0]).toLowerCase());
      if (!u) return ok([]);
      const vinculo = [...memberships.values()].find((m) => m.user_id === u.id);
      return ok([{
        id: u.id, name: u.name, email: u.email, password_hash: u.password_hash ?? null, status: u.status,
        must_change_password: Boolean(u.must_change_password), is_superadmin: supers.has(String(u.id)),
        tenant_id: vinculo?.tenant_id ?? null, role: vinculo?.role ?? null,
      }]);
    }
    if (q.startsWith('insert into auth_sessions')) {
      sessions.set(String(p[0]), { id: p[0], user_id: p[1], acting_as_tenant_id: null, last_seen_at: agora });
      return ok([]);
    }
    if (q.startsWith('select s.id as session_id, s.acting_as_tenant_id, s.last_seen_at')
      && q.includes('where s.id = $1 and s.expires_at > now()')) {
      // resolveSession: sessão + usuário + primeiro vínculo (como o `limit 1` do SQL real).
      const s = sessions.get(String(p[0]));
      const u = s ? users.get(String(s.user_id)) : undefined;
      if (!s || !u) return ok([]);
      const vinculo = [...memberships.values()].find((m) => m.user_id === u.id);
      return ok([{
        session_id: s.id, acting_as_tenant_id: s.acting_as_tenant_id ?? null, last_seen_at: s.last_seen_at ?? agora,
        user_id: u.id, name: u.name, email: u.email, status: u.status,
        must_change_password: Boolean(u.must_change_password), is_superadmin: supers.has(String(u.id)),
        tenant_id: vinculo?.tenant_id ?? null, role: vinculo?.role ?? null,
      }]);
    }
    if (q === 'select name from tenants where id = $1') {
      // getTenantName (nome da corretora na sessão).
      const t = tenants.get(String(p[0]));
      return ok(t ? [{ name: t.name }] : []);
    }

    throw new Error(`consulta não prevista no dublê: ${q}`);
  };

  return {
    pool: { query: exec, connect: async () => ({ query: exec, release: () => undefined }) },
    users,
    supers,
    memberships,
    tenants,
    sessions,
    auditoria,
    consultas,
  };
}

/** Troca o módulo do Postgres pelo dublê (todos os exports de valor do módulo). */
export function instalarBancoAdmin(banco: BancoAdmin): void {
  (mock.module as unknown as (s: string, o: { exports: Record<string, unknown> }) => void)(
    '../../src/db/postgres.js',
    {
      exports: {
        isPostgresConfigured: () => true,
        getPostgresConfig: () => ({ configured: true, ssl: false }),
        getPostgresPool: () => banco.pool,
      },
    },
  );
}
