/**
 * Redefinir senha no nível do store: as mesmas regras da rota
 * (tests/admin/redefinir-senha.test.ts) no InMemoryAdminStore — paridade com o
 * Postgres — e as recusas que a rota não alcança (quem chama sem corretora;
 * operador direto no store) no PostgresAdminStore.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAdminStore, PostgresAdminStore, PasswordResetNotAllowedError, UserNotFoundError } from '../../src/admin/store.js';
import type { AdminStore } from '../../src/admin/store.js';
import type { AuthContext } from '../../src/auth/context.js';
import { criarBancoAdmin } from '../_harness/bancoAdmin.js';

const SUPER: AuthContext = { userId: 'taskdun-superadmin', isSuperadmin: true, tenantId: null, role: 'superadmin' } as AuthContext;

/** Acesso de teste ao que o store em memória guarda (senha e status por usuário). */
type Interno = { users: Map<string, { id: string; status: string }>; senhas: Map<string, { hash: string; trocaObrigatoria: boolean }> };
const interno = (s: InMemoryAdminStore) => s as unknown as Interno;

async function montar() {
  const store = new InMemoryAdminStore();
  const { tenant: b, manager: gestorB } = await store.createTenantWithManager({
    documentType: 'cnpj', document: '94495241000100', brokerName: 'Corretora B', brokerPhone: '554833330000',
    managerName: 'Bia Admin', managerEmail: 'bia@b.com', managerWhatsapp: '5548999990000',
  });
  const criar = (tenantId: string, email: string, role: 'admin' | 'operador', passwordHash?: string) =>
    store.createUser(SUPER, { tenantId, name: email.split('@')[0], email, role, passwordHash });
  const admA = await criar('test', 'ana@a.com', 'admin', 'HASH-ANA');
  const admA2 = await criar('test', 'alice@a.com', 'admin', 'HASH-ALICE');
  const opA = await criar('test', 'otavio@a.com', 'operador', 'HASH-OTAVIO');
  const opB = await criar(b.id, 'bruno@b.com', 'operador', 'HASH-BRUNO');
  const opAB = await criar('test', 'duda@ab.com', 'operador', 'HASH-DUDA');
  await criar(b.id, 'duda@ab.com', 'operador');
  const off = await criar('test', 'davi@a.com', 'operador', 'HASH-DAVI');
  for (const [k, u] of interno(store).users) if (u.id === off.id) interno(store).users.set(k, { ...u, status: 'disabled' });
  const conv = await criar('test', 'clara@a.com', 'operador');
  const adminA = { userId: admA.id, isSuperadmin: false, tenantId: 'test', role: 'admin' } as AuthContext;
  return { store, b, gestorB, admA, admA2, opA, opB, opAB, off, conv, adminA };
}

function retrato(store: InMemoryAdminStore, id: string) {
  return {
    senha: structuredClone(interno(store).senhas.get(id)),
    status: [...interno(store).users.values()].filter((u) => u.id === id).map((u) => u.status),
  };
}

async function recusa(store: InMemoryAdminStore, auth: AuthContext, id: string, status: number, mensagem: string) {
  const antes = retrato(store, id);
  await assert.rejects(() => store.resetUserPassword(auth, id, 'HASH-NOVO'), (e: unknown) => {
    if (status === 404) assert.ok(e instanceof UserNotFoundError, `${id}: UserNotFoundError`);
    else {
      assert.ok(e instanceof PasswordResetNotAllowedError, `${id}: PasswordResetNotAllowedError`);
      assert.equal(e.status, status, `${id}: status`);
    }
    assert.equal((e as Error).message, mensagem);
    return true;
  });
  assert.deepEqual(retrato(store, id), antes, `${id}: nada muda`);
}

test('em memória: admin da corretora redefine operador da própria; senha nova com troca obrigatória', async () => {
  const m = await montar();
  const store: AdminStore = m.store;
  await store.resetUserPassword(m.adminA, m.opA.id, 'HASH-NOVO');
  assert.deepEqual(interno(m.store).senhas.get(m.opA.id), { hash: 'HASH-NOVO', trocaObrigatoria: true });
  const lista = await store.listUsers(SUPER);
  const op = lista.find((u) => u.id === m.opA.id)!;
  assert.equal(op.name, 'otavio', 'nada além da senha muda');
  assert.equal(op.role, 'operador');
});

test('em memória: as recusas do admin da corretora (404, 403, 400) e o superadmin intocável', async () => {
  const m = await montar();
  await recusa(m.store, m.adminA, m.opB.id, 404, 'usuário não encontrado');
  await recusa(m.store, m.adminA, 'u-nao-existe', 404, 'usuário não encontrado');
  await recusa(m.store, m.adminA, m.admA2.id, 403, 'só o suporte pode redefinir a senha deste usuário');
  await recusa(m.store, m.adminA, m.opAB.id, 403, 'só o suporte pode redefinir a senha deste usuário');
  await recusa(m.store, m.adminA, m.admA.id, 400, 'para trocar a sua própria senha, use "Trocar senha"');
  await recusa(m.store, m.adminA, 'taskdun-superadmin', 403, 'a senha do superadmin não é redefinida por aqui');
  await recusa(m.store, SUPER, 'taskdun-superadmin', 403, 'a senha do superadmin não é redefinida por aqui');
  const semCorretora = { ...m.adminA, tenantId: null } as AuthContext;
  await recusa(m.store, semCorretora, m.opA.id, 404, 'usuário não encontrado');
  const operador = { userId: m.opA.id, isSuperadmin: false, tenantId: 'test', role: 'operador' } as AuthContext;
  await recusa(m.store, operador, m.conv.id, 403, 'usuário sem permissão para gerenciar usuários');
});

test('em memória: superadmin redefine admin de outra corretora, dois vínculos e impersonando', async () => {
  const m = await montar();
  // O Admin criado com a corretora: convidado sem senha → ganha a senha e fica ativo.
  await m.store.resetUserPassword(SUPER, m.gestorB.id, 'HASH-B');
  assert.deepEqual(retrato(m.store, m.gestorB.id), { senha: { hash: 'HASH-B', trocaObrigatoria: true }, status: ['active'] });
  await m.store.resetUserPassword(SUPER, m.opAB.id, 'HASH-AB');
  assert.equal(interno(m.store).senhas.get(m.opAB.id)?.hash, 'HASH-AB');
  const impersonando = { userId: 'taskdun-superadmin', isSuperadmin: true, tenantId: 'test', role: 'admin' } as AuthContext;
  await m.store.resetUserPassword(impersonando, m.opB.id, 'HASH-BRUNO-2');
  assert.equal(interno(m.store).senhas.get(m.opB.id)?.hash, 'HASH-BRUNO-2');
});

test('em memória: desativado → 409; convidado sem senha fica ativo', async () => {
  const m = await montar();
  await recusa(m.store, SUPER, m.off.id, 409, 'usuário desativado');
  await recusa(m.store, m.adminA, m.off.id, 409, 'usuário desativado');
  await m.store.resetUserPassword(m.adminA, m.conv.id, 'HASH-CLARA');
  assert.deepEqual(retrato(m.store, m.conv.id), { senha: { hash: 'HASH-CLARA', trocaObrigatoria: true }, status: ['active'] });
});

test('Postgres: quem chama sem corretora e não é superadmin → 404; operador direto no store → 403; nada muda', async () => {
  const banco = criarBancoAdmin();
  banco.users.set('u-op', { id: 'u-op', name: 'Op', email: 'op@a.com', status: 'active', password_hash: 'HASH-OP', must_change_password: false });
  banco.memberships.set('u-op|corretora-a', { user_id: 'u-op', tenant_id: 'corretora-a', role: 'operador' });
  banco.sessions.set('s1', { id: 's1', user_id: 'u-op' });
  const store = new PostgresAdminStore(() => banco.pool as never);
  const antes = structuredClone({ u: banco.users.get('u-op'), s: [...banco.sessions.values()] });

  const semCorretora = { userId: 'u-adm', isSuperadmin: false, tenantId: null, role: 'admin' } as AuthContext;
  await assert.rejects(() => store.resetUserPassword(semCorretora, 'u-op', 'HASH-NOVO'), UserNotFoundError);
  const operador = { userId: 'u-op2', isSuperadmin: false, tenantId: 'corretora-a', role: 'operador' } as AuthContext;
  await assert.rejects(() => store.resetUserPassword(operador, 'u-op', 'HASH-NOVO'),
    (e: unknown) => e instanceof PasswordResetNotAllowedError && e.status === 403);

  assert.deepEqual({ u: banco.users.get('u-op'), s: [...banco.sessions.values()] }, antes);
  assert.equal(banco.auditoria.length, 0);
  assert.ok(banco.consultas.some((q) => q.sql === 'rollback'), 'a transação é desfeita');
  assert.ok(!banco.consultas.some((q) => q.sql === 'commit'));
});
