/**
 * Canário do harness. Se ESTE quebrar, o problema é montagem — não regressão.
 *
 * Congela a porta de entrada: primeira mensagem gera saudação + menu de intake,
 * e a escolha "1" leva o lead para a coleta de nome.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';
import { inbound, phone } from '../_harness/fixtures.js';

const ctrl = createCtrl();
installMocks(ctrl);

const { processWhatsappTurn } = await import('../../src/channels/whatsapp/orchestrator.js');

test('sessão nova: saúda e oferece cotação x atendente', async () => {
  ctrl.sent.length = 0;
  const r = await processWhatsappTurn(inbound('oi', { fromPhone: phone(100) }));

  assert.equal(r.action, 'greet');
  assert.ok(r.replySent, 'deve responder algo');
  assert.match(r.replySent ?? '', /Cotação de seguro/);
  assert.match(r.replySent ?? '', /Falar com um atendente/);
  assert.equal(r.sessionAfter?.stepId, 'service_type');
  assert.ok(ctrl.sent.length >= 1, 'deve ter enviado ao menos uma mensagem');
});

test('escolher "1" no intake avança para coleta de nome', async () => {
  const p = phone(101);
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound('1', { fromPhone: p }));

  assert.equal(r.action, 'branch_selected');
  assert.equal(r.sessionAfter?.stepId, 'name');
});
