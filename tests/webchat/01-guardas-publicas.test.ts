/**
 * Guardas do webchat público — os achados da revisão adversarial de b9559ff,
 * cada um virado teste. É endpoint aberto na internet, embutido em site de
 * terceiro: aqui o guard-rail É o produto.
 */

import './../_harness/env.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';

const ctrl = createCtrl();
ctrl.aiAutoAccept = true;
installMocks(ctrl);

const { origemPermitida, WEBCHAT_DEFAULTS, clearWebchatCache } = await import('../../src/tenant/webchat.js');
const { runWebchatTurn, novaConversaId } = await import('../../src/channels/webchat/adapter.js');
const { sessionStore } = await import('../../src/session/store.js');

beforeEach(() => {
  clearWebchatCache();
  ctrl.quoteMode = 'ok';
});

// ─── Domínios permitidos: promessa feita ao corretor na tela ────────────────

test('lista vazia = qualquer site embute (é o default, e a tela diz isso)', () => {
  const cfg = { ...WEBCHAT_DEFAULTS, allowedOrigins: [] };
  assert.equal(origemPermitida(cfg, 'https://qualquer-site.com'), true);
  assert.equal(origemPermitida(cfg, undefined), true);
});

test('com lista, só os domínios da corretora passam — inclusive subdomínio e com/sem www', () => {
  const cfg = { ...WEBCHAT_DEFAULTS, allowedOrigins: ['corretora.com.br'] };
  for (const bom of [
    'https://corretora.com.br',
    'http://corretora.com.br',
    'https://www.corretora.com.br',
    'https://blog.corretora.com.br/pagina?x=1',
  ]) {
    assert.equal(origemPermitida(cfg, bom), true, `deveria permitir ${bom}`);
  }
  for (const ruim of [
    'https://site-de-phishing.com',
    'https://corretora.com.br.golpe.com',
    'https://naocorretora.com.br',
    undefined,
  ]) {
    assert.equal(origemPermitida(cfg, ruim), false, `deveria recusar ${ruim}`);
  }
});

// ─── Atendente no webchat: não pode virar beco sem saída ───────────────────

test('webchat: pedir atendente NÃO pausa o agente — ele segue coletando o contato', async () => {
  const id = novaConversaId();
  await runWebchatTurn({ conversationId: id, text: 'oi', tenantId: 'test' });
  const r = await runWebchatTurn({ conversationId: id, text: 'quero falar com um atendente', tenantId: 'test' });

  assert.equal(r.action, 'human_handoff_requested');
  assert.match(r.messages.join(' '), /avisei nossa equipe/i);
  assert.match(r.messages.join(' '), /WhatsApp/i, 'pede o contato: é o que permite o humano retomar');

  const s = await sessionStore.get({ tenantId: 'test', channel: 'webchat', channelUserId: id });
  assert.equal(s?.humanOverride, null, 'nada de pausar num canal sem push');
  assert.equal(s?.stepId, 'name');

  // A prova que importa: a próxima fala do lead É respondida.
  const seguinte = await runWebchatTurn({ conversationId: id, text: 'Jera Souto', tenantId: 'test' });
  assert.ok(seguinte.messages.length > 0, 'o lead não pode falar com o vazio');
});

// ─── Simulador do painel: demonstração não gasta cotação real ───────────────

test('preview não dispara cotação — na Segfy toda cotação é real e conta pra corretora', async () => {
  const id = novaConversaId();
  const key = { tenantId: 'test', channel: 'webchat' as const, channelUserId: id };
  await runWebchatTurn({ conversationId: id, text: 'oi', tenantId: 'test', preview: true });
  const base = await sessionStore.get(key);
  assert.ok(base);
  await sessionStore.upsert({ ...base, stepId: 'quote_link' });

  ctrl.quotePayload = null;
  const r = await runWebchatTurn({ conversationId: id, text: 'pode', tenantId: 'test', preview: true });

  assert.equal(ctrl.quotePayload, null, 'o motor de cotação não pode ser chamado no simulador');
  assert.equal(r.action, 'calc_failed');
});

test('fora do preview, a cotação sai normalmente', async () => {
  const id = novaConversaId();
  const key = { tenantId: 'test', channel: 'webchat' as const, channelUserId: id };
  await runWebchatTurn({ conversationId: id, text: 'oi', tenantId: 'test' });
  const base = await sessionStore.get(key);
  assert.ok(base);
  await sessionStore.upsert({ ...base, stepId: 'quote_link' });

  ctrl.quotePayload = null;
  await runWebchatTurn({ conversationId: id, text: 'pode', tenantId: 'test' });
  assert.ok(ctrl.quotePayload, 'conversa real cota');
});
