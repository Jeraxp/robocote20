/**
 * Spec §7, passo 1 (critério 5 da prova): o superadmin cria a corretora com o
 * Admin e define a senha inicial dele em Usuários; o Admin entra.
 *
 * Antes da correção (revisão final, I2): o Admin nascia convidado e sem senha,
 * o cadastro com senha só fazia o vínculo (a senha era descartada), a rota
 * respondia `passwordSet: true` e o login dava 401.
 *
 * Rotas, store e login de verdade; só o Postgres é dublado
 * (tests/_harness/bancoAdmin.ts).
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarBancoAdmin, instalarBancoAdmin } from '../_harness/bancoAdmin.js';

const banco = criarBancoAdmin();
instalarBancoAdmin(banco);

const { api } = await import('../../src/routes/api.js');
const { hashPassword } = await import('../../src/auth/password.js');

const JSON_CT = { 'content-type': 'application/json' };
const SUPERADMIN = { ...JSON_CT, 'x-robocote-role': 'superadmin' };

async function postar(caminho: string, corpo: unknown, headers: Record<string, string> = SUPERADMIN): Promise<Response> {
  return api.request(caminho, { method: 'POST', body: JSON.stringify(corpo), headers });
}

function entrar(email: string, senha: string): Promise<Response> {
  return postar('/auth/login', { email, password: senha }, JSON_CT);
}

async function criarCorretora(nome: string, emailDoAdmin: string): Promise<string> {
  const res = await postar('/admin/tenants', {
    documentType: 'cnpj',
    document: '94.495.241/0001-00',
    brokerName: nome,
    brokerPhone: '(48) 3333-0000',
    managerName: 'Gestora de Teste',
    managerEmail: emailDoAdmin,
    managerWhatsapp: '(48) 99999-0000',
    createWhatsapp: false,
  });
  assert.equal(res.status, 201);
  const corpo = await res.json() as { tenant: { id: string }; manager: { status: string } };
  assert.equal(corpo.manager.status, 'invited', 'o Admin nasce convidado, sem senha');
  return corpo.tenant.id;
}

test('o Admin criado com a corretora recebe a senha inicial do superadmin e entra', async () => {
  const tenantId = await criarCorretora('Corretora IS Seguros', 'admin.is@exemplo.com.br');
  assert.equal(tenantId, 'corretora-is-seguros');

  const res = await postar('/admin/users', {
    tenantId,
    name: 'Gestora de Teste',
    email: 'admin.is@exemplo.com.br',
    role: 'admin',
    password: 'Senha-Inicial-123',
  });
  assert.equal(res.status, 201);
  const corpo = await res.json() as { passwordSet: boolean; user: { status: string; role: string; tenantId: string } };
  assert.equal(corpo.passwordSet, true);

  const login = await entrar('admin.is@exemplo.com.br', 'Senha-Inicial-123');
  assert.equal(login.status, 200, 'o Admin da corretora entra com a senha que o superadmin definiu');
  const sessao = await login.json() as { user: { role: string; tenantId: string; mustChangePassword: boolean } };
  assert.equal(sessao.user.role, 'admin');
  assert.equal(sessao.user.tenantId, 'corretora-is-seguros');
  assert.equal(sessao.user.mustChangePassword, true, 'troca obrigatória no 1º acesso, como usuário novo');

  assert.equal(corpo.user.status, 'active');
  assert.equal(corpo.user.role, 'admin');
  assert.equal(corpo.user.tenantId, 'corretora-is-seguros');
});

test('usuário que já tem senha só ganha o vínculo: a senha enviada é ignorada e a rota diz isso', async () => {
  const tenantId = await criarCorretora('Corretora Dois', 'admin.dois@exemplo.com.br');
  banco.users.set('u-op', {
    id: 'u-op',
    name: 'Operador de Outra',
    email: 'operador@exemplo.com.br',
    phone: null,
    status: 'active',
    password_hash: await hashPassword('Senha-Dele-123'),
    must_change_password: false,
  });
  banco.memberships.set('u-op|corretora-outra', { user_id: 'u-op', tenant_id: 'corretora-outra', role: 'operador' });
  const antes = structuredClone(banco.users.get('u-op'));

  const res = await postar('/admin/users', {
    tenantId,
    name: 'Outro Nome',
    email: 'operador@exemplo.com.br',
    role: 'operador',
    password: 'Senha-Nova-456',
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json() as { passwordSet: boolean }).passwordSet, false, 'passwordSet diz a verdade');
  assert.deepEqual(banco.users.get('u-op'), antes, 'usuário com senha nunca é alterado');
  assert.deepEqual(banco.memberships.get(`u-op|${tenantId}`), { user_id: 'u-op', tenant_id: tenantId, role: 'operador' });

  assert.equal((await entrar('operador@exemplo.com.br', 'Senha-Nova-456')).status, 401);
  assert.equal((await entrar('operador@exemplo.com.br', 'Senha-Dele-123')).status, 200);
});

test('usuário novo com senha: passwordSet true; sem senha: false', async () => {
  const tenantId = await criarCorretora('Corretora Tres', 'admin.tres@exemplo.com.br');
  const comSenha = await postar('/admin/users', { tenantId, name: 'Op Um', email: 'op.um@exemplo.com.br', role: 'operador', password: 'Senha-Op-123' });
  assert.equal((await comSenha.json() as { passwordSet: boolean }).passwordSet, true);
  assert.equal((await entrar('op.um@exemplo.com.br', 'Senha-Op-123')).status, 200);

  const semSenha = await postar('/admin/users', { tenantId, name: 'Op Dois', email: 'op.dois@exemplo.com.br', role: 'operador' });
  assert.equal((await semSenha.json() as { passwordSet: boolean }).passwordSet, false);
});
