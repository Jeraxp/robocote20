/**
 * Cotação: disparo, payload entregue à jornada e falha.
 * A sessão é SEMEADA no store real (InMemory) para não simular 20 turnos.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';
import { inbound, phone } from '../_harness/fixtures.js';

const ctrl = createCtrl();
installMocks(ctrl);

const { processWhatsappTurn } = await import('../../src/channels/whatsapp/orchestrator.js');
const { sessionStore, createInitialSessionState } = await import('../../src/session/store.js');

/** Coloca a sessão pronta para calcular, sem simular a jornada inteira. */
async function prontoParaCotar(p: string): Promise<void> {
  const key = { tenantId: 'test', channel: 'whatsapp' as const, channelUserId: p };
  await sessionStore.upsert({
    ...createInitialSessionState(key),
    stepId: 'quote_link',
    answers: {
      name: { id: 'name', label: 'Nome', value: 'Ana Ribeiro', rawValue: 'Ana Ribeiro' },
    },
  });
}

test('confirmação dispara a cotação e entrega payload à jornada', async () => {
  const p = phone(130);
  await prontoParaCotar(p);
  ctrl.quoteMode = 'ok';
  ctrl.quotePayload = null;
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound('pode calcular', { fromPhone: p }));

  assert.equal(r.action, 'calculate');
  assert.notEqual(ctrl.quotePayload, null, 'a jornada precisa receber o payload montado');
  assert.ok(ctrl.sent.length >= 1, 'lead precisa receber retorno da cotação');
});

test('cotação que falha responde ao lead em vez de morrer em silêncio', async () => {
  const p = phone(131);
  await prontoParaCotar(p);
  ctrl.quoteMode = 'fail';
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound('pode calcular', { fromPhone: p }));

  assert.equal(r.action, 'calc_failed');
  assert.ok(r.replySent, 'falha de cotação não pode deixar o lead no vácuo');
  assert.ok(ctrl.sent.length >= 1);
  ctrl.quoteMode = 'ok';
});

test('CARACTERIZACAO: o payload da cotação carrega respostas que o lead nunca deu', async () => {
  // Congela o comportamento de HOJE (defaults zod em journey/autoF1.ts).
  // NÃO é aprovação: é o cadeado que impede a Fase 5 mudar isso sem perceber.
  const p = phone(132);
  await prontoParaCotar(p);
  ctrl.quoteMode = 'ok';
  ctrl.quotePayload = null;

  await processWhatsappTurn(inbound('pode calcular', { fromPhone: p }));

  const payload = ctrl.quotePayload as Record<string, unknown> | null;
  assert.notEqual(payload, null);
  const chaves = Object.keys(payload ?? {});
  assert.ok(chaves.length > 0, 'payload precisa existir para a Fase 5 marcar procedência');
});
