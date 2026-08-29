/**
 * Porta de entrada: intake, handoff humano, reset, eco do bot e operador digitando.
 * Testes de CARACTERIZAÇÃO — congelam o comportamento de HOJE, defeitos inclusive.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';
import { inbound, phone } from '../_harness/fixtures.js';

const ctrl = createCtrl();
installMocks(ctrl);

const { processWhatsappTurn } = await import('../../src/channels/whatsapp/orchestrator.js');

async function novaConversa(p: string): Promise<void> {
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));
}

test('AMBIENTE: o .env de produção nunca é lido pela rede de testes', () => {
  assert.ok(!process.env.SEGFY_CLIENT_SECRET, 'credencial Segfy não pode vazar pro teste');
  assert.equal(process.env.TASKDUN_AI_API_KEY, '', 'chave de IA tem que estar neutralizada');
});

test('pedir atendente no intake aciona handoff e pausa o bot', async () => {
  const p = phone(110);
  await novaConversa(p);
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound('2', { fromPhone: p }));

  assert.equal(r.action, 'human_handoff_requested');
  assert.match(r.replySent ?? '', /atendente/i);
  assert.equal(r.sessionAfter?.humanOverride?.active, true);
  assert.equal(r.sessionAfter?.humanOverride?.source, 'lead_requested');
});

test('com operador ativo, o bot cala: não responde e só registra', async () => {
  const p = phone(111);
  await novaConversa(p);
  await processWhatsappTurn(inbound('2', { fromPhone: p })); // ativa handoff
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound('alguém aí?', { fromPhone: p }));

  assert.equal(r.action, 'human_paused');
  assert.equal(r.replySent, null, 'bot não pode responder com operador ativo');
  assert.equal(ctrl.sent.length, 0, 'nenhuma mensagem pode ser enviada');
});

test('mensagem do próprio número que NÃO é eco do bot = operador digitando pelo celular', async () => {
  const p = phone(112);
  await novaConversa(p);
  ctrl.isBotEcho = false;
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(
    inbound('oi, aqui é o corretor', { fromPhone: p, fromSelf: true }),
  );

  assert.equal(r.action, 'human_intervention');
  assert.equal(r.replySent, null);
  assert.equal(r.sessionAfter?.humanOverride?.active, true);
  assert.equal(r.sessionAfter?.humanOverride?.source, 'auto_detected');
  ctrl.isBotEcho = false;
});

test('eco da própria mensagem do bot é ignorado sem efeito colateral', async () => {
  const p = phone(113);
  await novaConversa(p);
  ctrl.isBotEcho = true;
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(
    inbound('Olá! Eu sou o Robocote', { fromPhone: p, fromSelf: true }),
  );

  assert.equal(r.replySent, null, 'eco não gera resposta');
  assert.equal(ctrl.sent.length, 0);
  assert.notEqual(r.action, 'human_intervention', 'eco não pode virar intervenção humana');
  ctrl.isBotEcho = false;
});

test('palavra-chave de reset recomeça a jornada do zero', async () => {
  const p = phone(114);
  await novaConversa(p);
  await processWhatsappTurn(inbound('1', { fromPhone: p }));
  await processWhatsappTurn(inbound('Jeronimo Souto', { fromPhone: p }));
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound('recomeçar', { fromPhone: p }));

  assert.equal(r.action, 'reset');
  assert.match(r.replySent ?? '', /come[çc]ar do zero/i);
  assert.equal(r.sessionAfter?.stepId, 'service_type', 'volta pro início da jornada');
});
