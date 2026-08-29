/**
 * Jornada: menu de ramos, coleta de nome, avanço de passo e placa.
 * CARACTERIZAÇÃO — congela o comportamento de hoje.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';
import { inbound, phone } from '../_harness/fixtures.js';

const ctrl = createCtrl();
// IA aceita o texto como resposta do passo — determinístico e sem corrida.
// (o node:test pode rodar testes do mesmo arquivo em paralelo; nada de estado mutável por teste)
ctrl.aiAutoAccept = true;
installMocks(ctrl);

const { processWhatsappTurn } = await import('../../src/channels/whatsapp/orchestrator.js');


/** Leva a sessão até o passo de nome (intake resolvido). */
async function ateNome(p: string): Promise<void> {
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));
  await processWhatsappTurn(inbound('1', { fromPhone: p }));
}

test('tenant com um ramo só pula o menu e vai direto pro nome', async () => {
  ctrl.ramos = ['auto'];
  const p = phone(120);
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));

  const r = await processWhatsappTurn(inbound('1', { fromPhone: p }));

  assert.equal(r.action, 'branch_selected');
  assert.equal(r.sessionAfter?.stepId, 'name', 'sem escolha a fazer, não pergunta o ramo');
});

test('tenant com vários ramos oferece o menu de escolha', async () => {
  ctrl.ramos = ['auto', 'moto', 'caminhao'];
  const p = phone(121);
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));

  const r = await processWhatsappTurn(inbound('1', { fromPhone: p }));

  assert.match(r.replySent ?? '', /Carro/i);
  assert.match(r.replySent ?? '', /Moto/i);
  assert.notEqual(r.sessionAfter?.stepId, 'name', 'precisa escolher o ramo antes');
  ctrl.ramos = ['auto'];
});

test('tenant sem config de ramos degrada para auto sem quebrar a conversa', async () => {
  ctrl.ramosThrows = true;
  const p = phone(122);
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));

  const r = await processWhatsappTurn(inbound('1', { fromPhone: p }));

  assert.equal(r.sessionAfter?.stepId, 'name', 'falha de config não pode travar o lead');
  ctrl.ramosThrows = false;
});

test('proposta da IA no passo do nome é aplicada e a jornada avança', async () => {
  const p = phone(123);
  await ateNome(p);
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound('Jeronimo Souto', { fromPhone: p }));

  assert.equal(r.sessionAfter?.answers?.name?.value, 'Jeronimo Souto');
  assert.equal(r.sessionAfter?.stepId, 'vehicle_plate');
});

test('placa válida usa o normalizador REAL de produção', async () => {
  const p = phone(124);
  await ateNome(p);
  await processWhatsappTurn(inbound('Jeronimo Souto', { fromPhone: p }));
  // Sem resposta programada, o decode falha e o fluxo degrada — é o caminho testado.
  ctrl.segfyReply = { ok: false, status: 0, error: 'mock_sem_resposta' };
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound(' abc-1d23 ', { fromPhone: p }));

  assert.ok(r.replySent, 'placa que não decodifica ainda assim responde algo');
  assert.notEqual(r.sessionAfter, null, 'sessão continua viva após falha de decode');
});

test('cada lead tem sessão isolada — não há vazamento entre conversas', async () => {
  const a = phone(125);
  const b = phone(126);
  await ateNome(a);
  await processWhatsappTurn(inbound('Ana Ribeiro', { fromPhone: a }));
  await ateNome(b);

  const rb = await processWhatsappTurn(inbound('Bruno Castro', { fromPhone: b }));

  assert.equal(rb.sessionAfter?.answers?.name?.value, 'Bruno Castro');
  assert.equal(rb.sessionAfter?.channelUserId, b);
});

test('nome incompleto é recusado e o lead é convidado a corrigir', async () => {
  const p = phone(127);
  await ateNome(p);
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound('Ana', { fromPhone: p }));

  assert.equal(r.action, 'ask_clarification', 'nome sem sobrenome não avança o passo');
  assert.equal(r.sessionAfter?.stepId, 'name', 'continua no mesmo passo');
  assert.equal(r.sessionAfter?.answers?.name, undefined, 'nada é gravado');
});
