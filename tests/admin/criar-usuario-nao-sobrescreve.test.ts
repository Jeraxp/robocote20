/**
 * Segurança: cadastrar usuário nunca altera usuário existente.
 * O caminho do Postgres roda contra um pool dublado que guarda linhas em memória
 * e interpreta as consultas do store; a implementação em memória roda os mesmos cenários.
 */
import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAdminStore, PostgresAdminStore } from '../../src/admin/store.js';
import type { AdminStore } from '../../src/admin/store.js';
import type { AuthContext } from '../../src/auth/context.js';

type Row = Record<string, unknown>;

function fakePool() {
  const users = new Map<string, Row>();
  const supers = new Set<string>();
  const memberships = new Map<string, Row>();
  const tenants = new Set(['corretora-a', 'corretora-b']);
  const exec = async (sql: string, p: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> => {
    const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const ok = (rows: Row[]) => ({ rows, rowCount: rows.length });
    if (q === 'begin' || q === 'commit' || q === 'rollback') return ok([]);
    if (q.startsWith('select 1 from tenants')) return ok(tenants.has(String(p[0])) ? [{}] : []);
    if (q.startsWith('select * from users where email')) return ok([...users.values()].filter((u) => u.email === p[0]));
    if (q.startsWith('select 1 from superadmin_users')) return ok(supers.has(String(p[0])) ? [{}] : []);
    if (q.startsWith('insert into users')) {
      if ([...users.values()].some((u) => u.email === p[2])) {
        if (q.includes('do nothing')) return ok([]);
        // caminho antigo: do update set ... sobrescreve a linha existente
        const cur = [...users.values()].find((u) => u.email === p[2])!;
        cur.name = p[1]; cur.phone = p[3];
        cur.password_hash = p[5] ?? cur.password_hash;
        if (p[5]) cur.must_change_password = true;
        return ok([cur]);
      }
      const row: Row = { id: p[0], name: p[1], email: p[2], phone: p[3], status: p[4], password_hash: p[5], must_change_password: p[6] };
      users.set(String(p[0]), row);
      return ok([row]);
    }
    if (q.startsWith("update users set password_hash = $2, status = 'active', must_change_password = true")
      && q.includes('where id = $1 and password_hash is null')) {
      const cur = users.get(String(p[0]));
      if (!cur || cur.password_hash) return ok([]);
      Object.assign(cur, { password_hash: p[1], status: 'active', must_change_password: true });
      return ok([cur]);
    }
    if (q.startsWith('insert into tenant_memberships')) {
      memberships.set(`${p[0]}|${p[1]}`, { user_id: p[0], tenant_id: p[1], role: p[2] });
      return ok([]);
    }
    if (q.startsWith('insert into audit_events')) return ok([]);
    throw new Error(`consulta não prevista no dublê: ${q}`);
  };
  const pool = { connect: async () => ({ query: exec, release: () => {} }) };
  return { pool: pool as never, users, supers, memberships };
}

const gestorA: AuthContext = { userId: 'gestor-a', isSuperadmin: false, tenantId: 'corretora-a', role: 'admin' } as AuthContext;
const super1: AuthContext = { userId: 'taskdun-superadmin', isSuperadmin: true, tenantId: null, role: 'superadmin' } as AuthContext;

function semeia(f: ReturnType<typeof fakePool>) {
  f.users.set('taskdun-superadmin', { id: 'taskdun-superadmin', name: 'Taskdun Superadmin', email: 'admin@taskdun.com.br', phone: null, status: 'active', password_hash: 'HASH-SUPER', must_change_password: false });
  f.supers.add('taskdun-superadmin');
  f.users.set('u-b', { id: 'u-b', name: 'Beto', email: 'beto@b.com', phone: '111', status: 'active', password_hash: 'HASH-BETO', must_change_password: false });
  f.memberships.set('u-b|corretora-b', { user_id: 'u-b', tenant_id: 'corretora-b', role: 'operador' });
  f.users.set('u-a', { id: 'u-a', name: 'Ana', email: 'ana@a.com', phone: '222', status: 'active', password_hash: 'HASH-ANA', must_change_password: false });
  f.memberships.set('u-a|corretora-a', { user_id: 'u-a', tenant_id: 'corretora-a', role: 'operador' });
  f.users.set('u-s2', { id: 'u-s2', name: 'Outro Super', email: 'super2@taskdun.com.br', phone: null, status: 'active', password_hash: 'HASH-S2', must_change_password: false });
  f.supers.add('u-s2');
  // Admin criado junto com a corretora: convidado e sem senha (createTenantWithManager).
  f.users.set('u-g', { id: 'u-g', name: 'Gestora', email: 'gestora@a.com', phone: '333', status: 'invited', password_hash: null, must_change_password: false });
  f.memberships.set('u-g|corretora-a', { user_id: 'u-g', tenant_id: 'corretora-a', role: 'admin' });
}

const novo = (over: Record<string, unknown>) => ({ tenantId: 'corretora-a', name: 'Invasor', email: 'x@x.com', role: 'operador' as const, passwordHash: 'HASH-ATACANTE', ...over });

test('gestor não troca a senha do superadmin cadastrando o e-mail dele', async () => {
  const f = fakePool(); semeia(f);
  const store = new PostgresAdminStore(() => f.pool);
  const antes = structuredClone(f.users.get('taskdun-superadmin'));
  await assert.rejects(() => store.createUser(gestorA, novo({ email: 'admin@taskdun.com.br' })), /e-mail já cadastrado/);
  assert.deepEqual(f.users.get('taskdun-superadmin'), antes);
  assert.equal(f.memberships.has('taskdun-superadmin|corretora-a'), false);
});

test('a comparação de e-mail ignora maiúsculas e espaços', async () => {
  const f = fakePool(); semeia(f);
  const store = new PostgresAdminStore(() => f.pool);
  const antes = structuredClone(f.users.get('taskdun-superadmin'));
  await assert.rejects(() => store.createUser(gestorA, novo({ email: ' Admin@Taskdun.com.br ' })), /e-mail já cadastrado/);
  assert.deepEqual(f.users.get('taskdun-superadmin'), antes);
});

test('gestor não altera usuário de outra corretora', async () => {
  const f = fakePool(); semeia(f);
  const store = new PostgresAdminStore(() => f.pool);
  const antes = structuredClone(f.users.get('u-b'));
  await assert.rejects(() => store.createUser(gestorA, novo({ email: 'beto@b.com' })), /e-mail já cadastrado/);
  assert.deepEqual(f.users.get('u-b'), antes);
  assert.equal(f.memberships.has('u-b|corretora-a'), false);
});

test('gestor não altera nem usuário da própria corretora pelo cadastro', async () => {
  const f = fakePool(); semeia(f);
  const store = new PostgresAdminStore(() => f.pool);
  const antes = structuredClone(f.users.get('u-a'));
  await assert.rejects(() => store.createUser(gestorA, novo({ email: 'ana@a.com' })), /e-mail já cadastrado/);
  assert.deepEqual(f.users.get('u-a'), antes);
});

test('superadmin vincula usuário existente a outra corretora sem mexer na senha', async () => {
  const f = fakePool(); semeia(f);
  const store = new PostgresAdminStore(() => f.pool);
  const antes = structuredClone(f.users.get('u-b'));
  const r = await store.createUser(super1, novo({ email: 'beto@b.com', tenantId: 'corretora-a', name: 'Novo Nome' }));
  assert.equal(r.id, 'u-b');
  assert.equal(r.tenantId, 'corretora-a');
  assert.equal(r.passwordSet, false, 'a senha enviada foi ignorada e o retorno diz isso');
  assert.deepEqual(f.users.get('u-b'), antes);
  assert.deepEqual(f.memberships.get('u-b|corretora-a'), { user_id: 'u-b', tenant_id: 'corretora-a', role: 'operador' });
});

test('superadmin define a senha inicial de quem ainda não tem senha: ativa e exige troca', async () => {
  const f = fakePool(); semeia(f);
  const store = new PostgresAdminStore(() => f.pool);
  const r = await store.createUser(super1, novo({ email: 'gestora@a.com', tenantId: 'corretora-a', role: 'admin', name: 'Nome Ignorado', passwordHash: 'HASH-INICIAL' }));
  assert.equal(r.id, 'u-g');
  assert.equal(r.passwordSet, true);
  assert.equal(r.status, 'active');
  assert.equal(r.role, 'admin');
  const row = f.users.get('u-g')!;
  assert.equal(row.password_hash, 'HASH-INICIAL');
  assert.equal(row.status, 'active');
  assert.equal(row.must_change_password, true, 'mesma troca obrigatória de um usuário novo');
  assert.equal(row.name, 'Gestora', 'só a senha e o status mudam');
  assert.equal(row.phone, '333');
});

test('superadmin sem senha no cadastro só vincula o convidado, que segue sem senha', async () => {
  const f = fakePool(); semeia(f);
  const store = new PostgresAdminStore(() => f.pool);
  const antes = structuredClone(f.users.get('u-g'));
  const r = await store.createUser(super1, novo({ email: 'gestora@a.com', tenantId: 'corretora-b', role: 'operador', passwordHash: undefined }));
  assert.equal(r.passwordSet, false);
  assert.deepEqual(f.users.get('u-g'), antes);
  assert.equal(f.memberships.get('u-g|corretora-b')?.role, 'operador');
});

test('gestor não define senha de convidado pelo cadastro', async () => {
  const f = fakePool(); semeia(f);
  const store = new PostgresAdminStore(() => f.pool);
  const antes = structuredClone(f.users.get('u-g'));
  await assert.rejects(() => store.createUser(gestorA, novo({ email: 'gestora@a.com' })), /e-mail já cadastrado/);
  assert.deepEqual(f.users.get('u-g'), antes);
});

test('superadmin também não altera outro superadmin pelo cadastro', async () => {
  const f = fakePool(); semeia(f);
  const store = new PostgresAdminStore(() => f.pool);
  const antes = structuredClone(f.users.get('u-s2'));
  await assert.rejects(() => store.createUser(super1, novo({ email: 'super2@taskdun.com.br' })), /e-mail já cadastrado/);
  assert.deepEqual(f.users.get('u-s2'), antes);
  assert.equal(f.memberships.has('u-s2|corretora-a'), false);
});

test('e-mail novo continua criando usuário com troca obrigatória', async () => {
  const f = fakePool(); semeia(f);
  const store = new PostgresAdminStore(() => f.pool);
  const r = await store.createUser(gestorA, novo({ email: 'novo@a.com', name: 'Novo' }));
  assert.equal(r.email, 'novo@a.com');
  assert.equal(r.passwordSet, true);
  const row = [...f.users.values()].find((u) => u.email === 'novo@a.com')!;
  assert.equal(row.must_change_password, true);
  assert.equal(row.status, 'active');
  assert.equal(row.password_hash, 'HASH-ATACANTE');
  assert.equal(f.memberships.get(`${row.id}|corretora-a`)?.role, 'operador');
});

// Implementação em memória: mesmas regras.
test('em memória: gestor não recadastra o superadmin nem usuário existente; superadmin só vincula', async () => {
  const store: AdminStore = new InMemoryAdminStore();
  const g = { userId: 'g', isSuperadmin: false, tenantId: 'test', role: 'admin' } as AuthContext;
  const s = { userId: 's', isSuperadmin: true, tenantId: null, role: 'superadmin' } as unknown as AuthContext;
  await assert.rejects(() => store.createUser(g, { tenantId: 'test', name: 'x', email: 'admin@taskdun.com.br', role: 'operador' }), /e-mail já cadastrado/);
  await assert.rejects(() => store.createUser(s, { tenantId: 'test', name: 'x', email: 'admin@taskdun.com.br', role: 'operador' }), /e-mail já cadastrado/);
  const criado = await store.createUser(g, { tenantId: 'test', name: 'Ana', email: 'ana@a.com', role: 'operador' });
  await assert.rejects(() => store.createUser(g, { tenantId: 'test', name: 'Troca', email: 'ANA@a.com', role: 'operador' }), /e-mail já cadastrado/);
  const lista = await store.listUsers(s);
  assert.equal(lista.find((u) => u.id === criado.id)?.name, 'Ana');
  const vinc = await store.createUser(s, { tenantId: 'test', name: 'Outro', email: 'ana@a.com', role: 'operador' });
  assert.equal(vinc.id, criado.id);
  assert.equal(vinc.name, 'Ana');
});

test('em memória: convidado sem senha ganha a senha inicial; quem tem senha só ganha vínculo', async () => {
  const store: AdminStore = new InMemoryAdminStore();
  const s = { userId: 's', isSuperadmin: true, tenantId: null, role: 'superadmin' } as unknown as AuthContext;
  const g = { userId: 'g', isSuperadmin: false, tenantId: 'test', role: 'admin' } as AuthContext;
  const { tenant, manager } = await store.createTenantWithManager({
    documentType: 'cnpj', document: '94495241000100', brokerName: 'Corretora IS Seguros', brokerPhone: '554833330000',
    managerName: 'Gestora', managerEmail: 'gestora@is.com', managerWhatsapp: '5548999990000',
  });
  assert.equal(manager.status, 'invited');
  await assert.rejects(() => store.createUser(g, { tenantId: 'test', name: 'x', email: 'gestora@is.com', role: 'operador', passwordHash: 'HASH-GESTOR' }), /e-mail já cadastrado/);

  const definida = await store.createUser(s, { tenantId: tenant.id, name: 'Outro Nome', email: 'gestora@is.com', role: 'admin', passwordHash: 'HASH-INICIAL' });
  assert.equal(definida.id, manager.id);
  assert.equal(definida.passwordSet, true);
  assert.equal(definida.status, 'active');
  assert.equal(definida.name, 'Gestora', 'só a senha e o status mudam');

  // Agora tem senha: um novo cadastro só vincula e não diz que definiu senha.
  const deNovo = await store.createUser(s, { tenantId: 'test', name: 'Gestora', email: 'gestora@is.com', role: 'operador', passwordHash: 'HASH-OUTRA' });
  assert.equal(deNovo.passwordSet, false);
  assert.equal(deNovo.tenantId, 'test');
  const lista = await store.listUsers(s);
  assert.ok(lista.filter((u) => u.id === manager.id).every((u) => u.status === 'active'));

  const novo = await store.createUser(s, { tenantId: 'test', name: 'Novo', email: 'novo@is.com', role: 'operador', passwordHash: 'HASH-NOVO' });
  assert.equal(novo.passwordSet, true);
  assert.equal(novo.status, 'active');
  const semSenha = await store.createUser(s, { tenantId: 'test', name: 'Sem', email: 'sem@is.com', role: 'operador' });
  assert.equal(semSenha.passwordSet, false);
  assert.equal(semSenha.status, 'invited');
});
