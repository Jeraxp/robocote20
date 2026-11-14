/**
 * "Redefinir senha" em Usuários: POST /api/admin/users/:userId/reset-password.
 *
 * Substitui o único caminho que existia para recuperar senha esquecida — o
 * cadastro que sobrescrevia a senha de quem já existia, e que permitia ao admin
 * de uma corretora tomar a conta do superadmin (corrigido em 13–14/11). As
 * regras de quem redefine quem vivem no store; aqui elas são provadas pelo `app`
 * inteiro, com login e sessão de verdade e só o Postgres dublado
 * (tests/_harness/bancoAdmin.ts).
 */

import './../_harness/env.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { criarBancoAdmin, instalarBancoAdmin, type Linha } from '../_harness/bancoAdmin.js';

// Sem sessão, sem painel (o token de painel do modo dev fica desligado aqui).
process.env.ROBOCOTE_DISABLE_TOKEN_AUTH = '1';

const banco = criarBancoAdmin();
instalarBancoAdmin(banco);

// Em produção o app é montado dentro de src/index.ts (que sobe o servidor ao ser
// importado); aqui monta-se só o roteador /api, que é onde a rota vive.
const { Hono } = await import('hono');
const { api } = await import('../../src/routes/api.js');
const app = new Hono().route('/api', api);
const { hashPassword } = await import('../../src/auth/password.js');

const SENHA = {
  super: 'Senha-Super-1',
  admA: 'Senha-AdmA-1',
  admA2: 'Senha-AdmA2-1',
  admB: 'Senha-AdmB-1',
  opA: 'Senha-OpA-1',
  opA2: 'Senha-OpA2-1',
  opB: 'Senha-OpB-1',
  opAB: 'Senha-OpAB-1',
  off: 'Senha-Off-1',
};
const HASH = Object.fromEntries(
  await Promise.all(Object.entries(SENHA).map(async ([k, v]) => [k, await hashPassword(v)])),
) as Record<keyof typeof SENHA, string>;

const pessoa = (id: string, name: string, email: string, status: string, password_hash: string | null): Linha =>
  ({ id, name, email, phone: '5548999990000', status, password_hash, must_change_password: false });

function semear(): void {
  banco.users.clear(); banco.supers.clear(); banco.memberships.clear(); banco.tenants.clear();
  banco.sessions.clear(); banco.auditoria.length = 0; banco.consultas.length = 0;
  for (const id of ['corretora-a', 'corretora-b']) banco.tenants.set(id, { id, slug: id, name: `Corretora ${id.slice(-1).toUpperCase()}`, status: 'active' });
  const vincular = (user_id: string, tenant_id: string, role: string) =>
    banco.memberships.set(`${user_id}|${tenant_id}`, { user_id, tenant_id, role });

  banco.users.set('u-super', pessoa('u-super', 'Taskdun Superadmin', 'admin@taskdun.com.br', 'active', HASH.super));
  banco.supers.add('u-super');
  banco.users.set('u-adm-a', pessoa('u-adm-a', 'Ana Admin', 'ana@a.com', 'active', HASH.admA));
  vincular('u-adm-a', 'corretora-a', 'admin');
  banco.users.set('u-adm-a2', pessoa('u-adm-a2', 'Alice Admin', 'alice@a.com', 'active', HASH.admA2));
  vincular('u-adm-a2', 'corretora-a', 'admin');
  banco.users.set('u-adm-b', pessoa('u-adm-b', 'Bia Admin', 'bia@b.com', 'active', HASH.admB));
  vincular('u-adm-b', 'corretora-b', 'admin');
  banco.users.set('u-op-a', pessoa('u-op-a', 'Otávio Operador', 'otavio@a.com', 'active', HASH.opA));
  vincular('u-op-a', 'corretora-a', 'operador');
  banco.users.set('u-op-a2', pessoa('u-op-a2', 'Olga Operadora', 'olga@a.com', 'active', HASH.opA2));
  vincular('u-op-a2', 'corretora-a', 'operador');
  banco.users.set('u-op-b', pessoa('u-op-b', 'Bruno Operador', 'bruno@b.com', 'active', HASH.opB));
  vincular('u-op-b', 'corretora-b', 'operador');
  // Operador da A que também entra na B: quem o redefine entra na B.
  banco.users.set('u-op-ab', pessoa('u-op-ab', 'Duda Dupla', 'duda@ab.com', 'active', HASH.opAB));
  vincular('u-op-ab', 'corretora-a', 'operador');
  vincular('u-op-ab', 'corretora-b', 'operador');
  banco.users.set('u-off', pessoa('u-off', 'Davi Desativado', 'davi@a.com', 'disabled', HASH.off));
  vincular('u-off', 'corretora-a', 'operador');
  // Convidado sem senha (como o Admin criado com a corretora).
  banco.users.set('u-conv', pessoa('u-conv', 'Clara Convidada', 'clara@a.com', 'invited', null));
  vincular('u-conv', 'corretora-a', 'operador');

  // Uma sessão aberta de cada usuário, para provar quem é desconectado.
  for (const id of banco.users.keys()) banco.sessions.set(`sessao-${id}`, { id: `sessao-${id}`, user_id: id, acting_as_tenant_id: null, last_seen_at: new Date() });
}

beforeEach(semear);

const JSON_CT = { 'content-type': 'application/json' };

async function entrar(email: string, senha: string): Promise<Response> {
  return await app.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: senha }), headers: JSON_CT });
}

/** Login de verdade; devolve o cabeçalho de cookie da sessão. */
async function sessao(email: string, senha: string): Promise<string> {
  const res = await entrar(email, senha);
  assert.equal(res.status, 200, `login de ${email}`);
  const cookie = res.headers.get('set-cookie') ?? '';
  const m = /rbc_session=([^;]+)/.exec(cookie);
  assert.ok(m, 'login devolve o cookie de sessão');
  return `rbc_session=${m[1]}`;
}

async function redefinir(userId: string, cookie?: string): Promise<Response> {
  return await app.request(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  });
}

const comoAdminA = () => sessao('ana@a.com', SENHA.admA);
const comoSuper = () => sessao('admin@taskdun.com.br', SENHA.super);

test('1. sem sessão → 401; operador → 403', async () => {
  const semSessao = await redefinir('u-op-a');
  assert.equal(semSessao.status, 401);

  const operador = await sessao('olga@a.com', SENHA.opA2);
  const res = await redefinir('u-op-a', operador);
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: string }).error, 'usuário sem permissão para gerenciar usuários');
  assert.equal(banco.users.get('u-op-a')!.password_hash, HASH.opA);
});

type Ok = { ok: boolean; temporaryPassword: string };
type Erro = { ok: boolean; error: string };

const sessoesDe = (userId: string) => [...banco.sessions.values()].filter((s) => s.user_id === userId);

test('2. admin da corretora redefine operador da própria: senha temporária, troca obrigatória, sessões derrubadas, auditoria sem segredo', async () => {
  const cookie = await comoAdminA();
  // O operador estava logado com a senha antiga.
  await sessao('otavio@a.com', SENHA.opA);
  assert.ok(sessoesDe('u-op-a').length >= 2);
  const sessoesDoAdmin = sessoesDe('u-adm-a').length;

  const res = await redefinir('u-op-a', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const corpo = await res.json() as Ok;
  assert.equal(corpo.ok, true);
  assert.match(corpo.temporaryPassword, /^Rbc-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);

  assert.deepEqual(sessoesDe('u-op-a'), [], 'quem estava logado com a senha antiga sai');
  assert.equal(sessoesDe('u-adm-a').length, sessoesDoAdmin, 'a sessão de quem redefiniu continua');

  assert.equal((await entrar('otavio@a.com', SENHA.opA)).status, 401, 'a senha antiga deixa de valer');
  const login = await entrar('otavio@a.com', corpo.temporaryPassword);
  assert.equal(login.status, 200, 'a senha temporária entra');
  assert.equal((await login.json() as { user: { mustChangePassword: boolean } }).user.mustChangePassword, true);

  const linha = banco.users.get('u-op-a')!;
  assert.equal(linha.must_change_password, true);
  assert.equal(linha.status, 'active');
  assert.equal(linha.name, 'Otávio Operador', 'nada além da senha muda');
  assert.equal(linha.email, 'otavio@a.com');
  assert.deepEqual(banco.memberships.get('u-op-a|corretora-a'), { user_id: 'u-op-a', tenant_id: 'corretora-a', role: 'operador' });

  const eventos = banco.auditoria.filter((e) => e.action === 'user.password_reset');
  assert.equal(eventos.length, 1);
  assert.deepEqual(eventos[0], {
    tenant_id: 'corretora-a',
    actor_user_id: 'u-adm-a',
    action: 'user.password_reset',
    entity_type: 'user',
    entity_id: 'u-op-a',
    metadata: { actorRole: 'admin', targetRole: 'operador' },
  });
  const tudo = JSON.stringify(banco.auditoria);
  assert.ok(!tudo.includes('otavio@a.com'), 'sem e-mail na auditoria');
  assert.ok(!tudo.includes(corpo.temporaryPassword), 'sem senha na auditoria');
  assert.ok(!tudo.includes(String(linha.password_hash)), 'sem hash na auditoria');
  // A senha em claro nunca vai ao banco: só o hash.
  assert.ok(!banco.consultas.some((q) => q.params.some((p) => String(p).includes(corpo.temporaryPassword))));
});

/** password_hash, must_change_password, status e as sessões do alvo, para comparar antes/depois. */
function retrato(userId: string) {
  const u = banco.users.get(userId);
  return {
    password_hash: u?.password_hash,
    must_change_password: u?.must_change_password,
    status: u?.status,
    sessoes: sessoesDe(userId).map((s) => s.id).sort(),
  };
}

async function recusa(userId: string, cookie: string, status: number, mensagem: string): Promise<void> {
  const antes = retrato(userId);
  const res = await redefinir(userId, cookie);
  assert.equal(res.status, status, `${userId}: status`);
  const corpo = await res.json() as Erro & { temporaryPassword?: string };
  assert.equal(corpo.error, mensagem);
  assert.equal(corpo.temporaryPassword, undefined);
  assert.deepEqual(retrato(userId), antes, `${userId}: nada muda`);
  assert.equal(banco.auditoria.filter((e) => e.action === 'user.password_reset').length, 0, 'recusa não audita redefinição');
}

test('3. admin da corretora → operador de outra corretora: 404, sem revelar que existe', async () => {
  const cookie = await comoAdminA();
  await recusa('u-op-b', cookie, 404, 'usuário não encontrado');
  await recusa('u-nao-existe', cookie, 404, 'usuário não encontrado');
});

test('4. admin da corretora → outro admin da própria corretora: 403', async () => {
  const cookie = await comoAdminA();
  await recusa('u-adm-a2', cookie, 403, 'só o suporte pode redefinir a senha deste usuário');
});

test('5. admin da corretora → operador que também entra em outra corretora: 403', async () => {
  const cookie = await comoAdminA();
  await recusa('u-op-ab', cookie, 403, 'só o suporte pode redefinir a senha deste usuário');
});

test('6. ninguém redefine a si mesmo por aqui (400) nem o superadmin (403, nem ele mesmo)', async () => {
  const admin = await comoAdminA();
  await recusa('u-adm-a', admin, 400, 'para trocar a sua própria senha, use "Trocar senha"');
  await recusa('u-super', admin, 403, 'a senha do superadmin não é redefinida por aqui');

  const superadmin = await comoSuper();
  await recusa('u-super', superadmin, 403, 'a senha do superadmin não é redefinida por aqui');
  // Outro superadmin também não.
  banco.users.set('u-super2', pessoa('u-super2', 'Suporte Dois', 'suporte2@taskdun.com.br', 'active', HASH.super));
  banco.supers.add('u-super2');
  await recusa('u-super2', superadmin, 403, 'a senha do superadmin não é redefinida por aqui');
});

test('7. superadmin redefine admin de qualquer corretora, também com dois vínculos e impersonando', async () => {
  const cookie = await comoSuper();
  const res = await redefinir('u-adm-b', cookie);
  assert.equal(res.status, 200);
  const { temporaryPassword } = await res.json() as Ok;
  assert.deepEqual(sessoesDe('u-adm-b'), []);
  assert.equal((await entrar('bia@b.com', temporaryPassword)).status, 200);
  const [evento] = banco.auditoria.filter((e) => e.action === 'user.password_reset');
  assert.equal(evento.tenant_id, 'corretora-b');
  assert.deepEqual(evento.metadata, { actorRole: 'superadmin', targetRole: 'admin' });

  // Dois vínculos (operador na A e na B): só o suporte pode, e pode. tenant_id fica nulo.
  const dois = await redefinir('u-op-ab', cookie);
  assert.equal(dois.status, 200);
  const evento2 = banco.auditoria.filter((e) => e.action === 'user.password_reset')[1];
  assert.equal(evento2.entity_id, 'u-op-ab');
  assert.equal(evento2.tenant_id, null, 'com mais de um vínculo, a auditoria não escolhe corretora');

  // Impersonando a corretora A, continua superadmin: redefine o admin da B.
  const sid = cookie.split('=')[1];
  banco.sessions.get(sid)!.acting_as_tenant_id = 'corretora-a';
  const impersonando = await redefinir('u-adm-b', cookie);
  assert.equal(impersonando.status, 200);
});

test('8. desativado → 409; convidado sem senha → 200 e fica ativo', async () => {
  const cookie = await comoSuper();
  await recusa('u-off', cookie, 409, 'usuário desativado');
  const admin = await comoAdminA();
  await recusa('u-off', admin, 409, 'usuário desativado');

  const res = await redefinir('u-conv', admin);
  assert.equal(res.status, 200);
  const { temporaryPassword } = await res.json() as Ok;
  const linha = banco.users.get('u-conv')!;
  assert.equal(linha.status, 'active', 'convidado vira ativo');
  assert.equal(linha.must_change_password, true);
  const login = await entrar('clara@a.com', temporaryPassword);
  assert.equal(login.status, 200);
  assert.equal((await login.json() as { user: { mustChangePassword: boolean } }).user.mustChangePassword, true);
});

test('9. a senha temporária não aparece em console.log/info/warn/error durante a requisição', async () => {
  const cookie = await comoAdminA();
  const saida: string[] = [];
  const metodos = ['log', 'info', 'warn', 'error'] as const;
  const originais = metodos.map((m) => console[m]);
  for (const m of metodos) console[m] = (...args: unknown[]) => { saida.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' ')); };
  let corpo: Ok;
  try {
    const res = await redefinir('u-op-a', cookie);
    assert.equal(res.status, 200);
    corpo = await res.json() as Ok;
  } finally {
    metodos.forEach((m, i) => { console[m] = originais[i]; });
  }
  const hash = String(banco.users.get('u-op-a')!.password_hash);
  assert.ok(!saida.join('\n').includes(corpo.temporaryPassword), 'senha temporária fora do log');
  assert.ok(!saida.join('\n').includes(hash), 'hash fora do log');
});
