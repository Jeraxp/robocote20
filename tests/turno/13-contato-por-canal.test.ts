/**
 * Contato por canal (decisão Jera 04/09): no WhatsApp o número JÁ É a conversa —
 * perguntar "qual WhatsApp o corretor pode usar?" é perguntar o que se sabe.
 * No webchat o lead é anônimo: a pergunta continua.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';
import { inbound, phone } from '../_harness/fixtures.js';

const ctrl = createCtrl();
ctrl.aiAutoAccept = true;
installMocks(ctrl);

const { processWhatsappTurn } = await import('../../src/channels/whatsapp/orchestrator.js');
const { runWebchatTurn, novaConversaId } = await import('../../src/channels/webchat/adapter.js');
const { sessionStore } = await import('../../src/session/store.js');
const { nextStepAfter } = await import('../../src/core/conversation/steps.js');

test('WhatsApp: a sessão nasce com o contato = número da conversa, com procedência do canal', async () => {
  const p = phone(170);
  const r = await processWhatsappTurn(inbound('oi', { fromPhone: p }));
  const contato = r.sessionAfter?.answers.contact;
  assert.equal(contato?.rawValue, p);
  assert.equal((contato?.metadata as { source?: string } | undefined)?.source, 'channel');
});

test('WhatsApp: o step de contato é pulado na jornada de auto (coverage → condutor principal)', () => {
  const comContato = { contact: { id: 'contact', label: 'Contato', value: '5548999990000', rawValue: '5548999990000' } };
  assert.equal(nextStepAfter('coverage', comContato), 'is_main_driver');
  assert.equal(nextStepAfter('coverage', {}), 'contact', 'sem contato conhecido, pergunta');
});

test('WhatsApp: o reset ("reiniciar") também preserva o contato do canal', async () => {
  const p = phone(171);
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));
  const r = await processWhatsappTurn(inbound('reiniciar', { fromPhone: p }));
  assert.equal(r.action, 'reset');
  assert.equal(r.sessionAfter?.answers.contact?.rawValue, p);
});

test('Webchat: o lead é anônimo — nada de contato pré-preenchido, a pergunta continua', async () => {
  const id = novaConversaId();
  await runWebchatTurn({ conversationId: id, text: 'oi', tenantId: 'test' });
  const s = await sessionStore.get({ tenantId: 'test', channel: 'webchat', channelUserId: id });
  assert.ok(s);
  assert.equal(s?.answers.contact, undefined);
  assert.equal(nextStepAfter('coverage', s?.answers ?? {}), 'contact');
});
