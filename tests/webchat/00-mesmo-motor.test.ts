/**
 * FASE 4 — o webchat passa a usar o MESMO motor do WhatsApp.
 *
 * As três provas que importam:
 *  (a) F5 no meio da conversa e ela continua de onde parou;
 *  (b) o lead de webchat vira card no painel, com histórico;
 *  (c) o webchat ganha a jornada inteira de graça — sem uma linha nova.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';

const ctrl = createCtrl();
ctrl.aiAutoAccept = true;
installMocks(ctrl);

const { runWebchatTurn, readWebchatSession, novaConversaId } =
  await import('../../src/channels/webchat/adapter.js');
const { sessionStore } = await import('../../src/session/store.js');

test('primeira mensagem do webchat é atendida pelo motor compartilhado', async () => {
  const id = novaConversaId();

  const r = await runWebchatTurn({ conversationId: id, text: 'oi', tenantId: 'test' });

  assert.equal(r.action, 'greet');
  assert.ok(r.messages.length >= 1, 'as falas do bot voltam na resposta do turno');
  assert.match(r.messages.join(' '), /Cotação de seguro/);
  assert.equal(r.stepId, 'service_type');
});

test('(a) F5 NÃO mata o lead: a conversa é retomada de onde parou', async () => {
  const id = novaConversaId();
  await runWebchatTurn({ conversationId: id, text: 'oi', tenantId: 'test' });
  await runWebchatTurn({ conversationId: id, text: '1', tenantId: 'test' });
  await runWebchatTurn({ conversationId: id, text: 'Ana Ribeiro', tenantId: 'test' });

  // Simula o F5: nenhum estado de cliente sobrevive, só o id do cookie.
  const retomada = await readWebchatSession(id, 'test');

  assert.equal(retomada.exists, true, 'a conversa precisa existir no servidor');
  assert.equal(retomada.stepId, 'vehicle_plate', 'continua exatamente onde parou');
  assert.ok(retomada.history.length >= 4, 'o histórico da conversa é preservado');
  assert.ok(
    retomada.history.some((h) => h.text.includes('Ana Ribeiro')),
    'o que o lead já disse não se perde',
  );
});

test('(b) o lead de webchat vira card no painel, com nome e histórico', async () => {
  const id = novaConversaId();
  await runWebchatTurn({ conversationId: id, text: 'oi', tenantId: 'test' });
  await runWebchatTurn({ conversationId: id, text: '1', tenantId: 'test' });
  await runWebchatTurn({ conversationId: id, text: 'Bruno Castro', tenantId: 'test' });

  const leads = await sessionStore.list({ tenantId: 'test', limit: 500 });
  const lead = leads.find((l) => l.channel === 'webchat' && l.channelUserId === id);

  assert.ok(lead, 'o webchat precisa gerar lead salvo — hoje ele gera zero');
  assert.equal(lead?.answers?.name?.value, 'Bruno Castro');
  assert.ok((lead?.interactions?.length ?? 0) >= 4, 'com histórico de mensagens');
  assert.equal(lead?.pipelineStage, 'contatados', 'entra no funil como lead trabalhado');
});

test('(c) o webchat ganha o pedido de atendente sem uma linha nova de jornada', async () => {
  const id = novaConversaId();
  await runWebchatTurn({ conversationId: id, text: 'oi', tenantId: 'test' });

  const r = await runWebchatTurn({ conversationId: id, text: '2', tenantId: 'test' });

  assert.equal(r.action, 'human_handoff_requested', 'existia só no WhatsApp; agora vale nos dois');
  assert.match(r.messages.join(' '), /atendente/i);
});

test('(c) o webchat ganha a proposta pendente — IA propõe, lead confirma', async () => {
  const id = novaConversaId();
  const chave = { tenantId: 'test', channel: 'webchat' as const, channelUserId: id };
  const { createInitialSessionState } = await import('../../src/session/store.js');
  await sessionStore.upsert({
    ...createInitialSessionState(chave),
    stepId: 'usage',
    pendingProposal: { stepId: 'usage', value: 'work', displayLabel: 'Trabalho' },
  });

  const r = await runWebchatTurn({ conversationId: id, text: 'sim', tenantId: 'test' });

  assert.equal(r.action, 'answer_step');
  assert.match(r.messages.join(' '), /Anotei: Trabalho/);
});

test('conversas diferentes não se misturam', async () => {
  const a = novaConversaId();
  const b = novaConversaId();
  await runWebchatTurn({ conversationId: a, text: 'oi', tenantId: 'test' });
  await runWebchatTurn({ conversationId: a, text: '1', tenantId: 'test' });
  await runWebchatTurn({ conversationId: a, text: 'Ana Ribeiro', tenantId: 'test' });
  await runWebchatTurn({ conversationId: b, text: 'oi', tenantId: 'test' });

  const va = await readWebchatSession(a, 'test');
  const vb = await readWebchatSession(b, 'test');

  assert.equal(va.stepId, 'vehicle_plate');
  assert.equal(vb.stepId, 'service_type', 'a conversa nova começa do começo');
});

test('DETECTOR: link sem corretora marca a sessão em vez de fingir que sabe', async () => {
  const id = novaConversaId();

  const r = await runWebchatTurn({ conversationId: id, text: 'oi' });

  assert.equal(r.tenantUnresolved, true, 'link sem corretora precisa ficar visível');
});
