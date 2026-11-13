/**
 * Admin de uma corretora não lista os usuários de outra (revisão final, I7).
 *
 * Antes: `GET /api/admin/users?tenantId=<outra>` aceitava a query de qualquer
 * um que gerencia usuários, e o store do Postgres usava o id sem conferir — o
 * admin da IS recebeu nome, e-mail, papel e telefone mascarado do gestor de
 * outra corretora.
 *
 * Escolha: quem não é superadmin recebe SÓ a própria corretora (a query é
 * ignorada), como já faz a listagem de WhatsApp. A rota ignora a query, e o
 * store recusa corretora alheia mesmo se a rota errar (defesa em profundidade).
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarBancoAdmin, instalarBancoAdmin } from '../_harness/bancoAdmin.js';
import type { AuthContext } from '../../src/auth/context.js';

const banco = criarBancoAdmin();
instalarBancoAdmin(banco);

for (const id of ['corretora-a', 'corretora-b']) banco.tenants.set(id, { id, slug: id, name: id, status: 'active' });
const pessoa = (id: string, name: string, email: string, phone: string) =>
  ({ id, name, email, phone, status: 'active', password_hash: 'HASH', must_change_password: false });
banco.users.set('u-a', pessoa('u-a', 'Ana', 'ana@a.com', '5548999990001'));
banco.users.set('u-a2', pessoa('u-a2', 'Alice', 'alice@a.com', '5548999990003'));
banco.users.set('u-b', pessoa('u-b', 'Beto', 'beto@b.com', '5548999990002'));
banco.memberships.set('u-a|corretora-a', { user_id: 'u-a', tenant_id: 'corretora-a', role: 'admin' });
banco.memberships.set('u-a2|corretora-a', { user_id: 'u-a2', tenant_id: 'corretora-a', role: 'operador' });
banco.memberships.set('u-b|corretora-b', { user_id: 'u-b', tenant_id: 'corretora-b', role: 'admin' });

const { api } = await import('../../src/routes/api.js');
const { PostgresAdminStore, InMemoryAdminStore } = await import('../../src/admin/store.js');

const ADMIN_A = { 'x-robocote-role': 'admin', 'x-robocote-tenant-id': 'corretora-a' };
const adminA = { userId: 'u-a', isSuperadmin: false, tenantId: 'corretora-a', role: 'admin' } as AuthContext;

async function emails(res: Response): Promise<string[]> {
  assert.equal(res.status, 200);
  const corpo = await res.json() as { users: Array<{ email: string }> };
  return corpo.users.map((u) => u.email).sort();
}

test('admin da corretora A pedindo ?tenantId=corretora-b recebe só a própria corretora', async () => {
  const res = await api.request('/admin/users?tenantId=corretora-b', { headers: ADMIN_A });
  assert.deepEqual(await emails(res), ['alice@a.com', 'ana@a.com']);
});

test('sem query, o admin continua vendo a própria corretora', async () => {
  const res = await api.request('/admin/users', { headers: ADMIN_A });
  assert.deepEqual(await emails(res), ['alice@a.com', 'ana@a.com']);
});

test('superadmin continua escolhendo a corretora pela query', async () => {
  const res = await api.request('/admin/users?tenantId=corretora-b', { headers: { 'x-robocote-role': 'superadmin' } });
  assert.deepEqual(await emails(res), ['beto@b.com']);
});

test('o store do Postgres recusa corretora alheia para quem não é superadmin', async () => {
  const store = new PostgresAdminStore(() => banco.pool as never);
  const users = await store.listUsers(adminA, 'corretora-b');
  assert.deepEqual(users.map((u) => u.email).sort(), ['alice@a.com', 'ana@a.com']);
  const semCorretora = { ...adminA, tenantId: null } as AuthContext;
  assert.deepEqual(await store.listUsers(semCorretora, 'corretora-b'), [], 'sem corretora própria, nada');
});

test('o store em memória segue a mesma regra', async () => {
  const store = new InMemoryAdminStore();
  const { tenant } = await store.createTenantWithManager({
    documentType: 'cnpj', document: '94495241000100', brokerName: 'Outra Corretora', brokerPhone: '554833330000',
    managerName: 'Gestor Outro', managerEmail: 'gestor@outra.com', managerWhatsapp: '5548999990000',
  });
  const adminTest = { userId: 'g', isSuperadmin: false, tenantId: 'test', role: 'admin' } as AuthContext;
  const users = await store.listUsers(adminTest, tenant.id);
  assert.ok(users.length > 0, 'recebe a própria corretora');
  assert.ok(users.every((u) => u.tenantId === 'test'));
  assert.ok(!users.some((u) => u.email === 'gestor@outra.com'));
});
