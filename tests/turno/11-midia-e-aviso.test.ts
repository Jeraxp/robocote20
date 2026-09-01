/**
 * Duas doutrinas do canal oficial (contrato KING, decisão Jera 01/09):
 *  - a PRIMEIRA fala do robô carrega o aviso de IA;
 *  - áudio/foto/arquivo recebem resposta educada e NÃO movem a jornada.
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

test('a primeira resposta avisa que é IA — e o reset não repete o aviso', async () => {
  const p = phone(140);
  const primeira = await processWhatsappTurn(inbound('oi', { fromPhone: p }));
  assert.equal(primeira.action, 'greet');
  assert.match(primeira.replySent ?? '', /inteligência artificial/i);

  const reset = await processWhatsappTurn(inbound('reiniciar', { fromPhone: p }));
  assert.equal(reset.action, 'reset');
  assert.doesNotMatch(reset.replySent ?? '', /inteligência artificial/i, 'quem já foi avisado não precisa ouvir de novo');
});

test('áudio no meio da conversa: resposta educada, jornada parada onde estava', async () => {
  const p = phone(141);
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));
  const antes = await processWhatsappTurn(inbound('1', { fromPhone: p }));
  const stepAntes = antes.sessionAfter?.stepId;

  const r = await processWhatsappTurn(inbound('', { fromPhone: p, unsupportedType: 'audio', messageId: 'wamid.AUD' }));

  assert.equal(r.action, 'unsupported_media');
  assert.match(r.replySent ?? '', /áudio/i);
  assert.match(r.replySent ?? '', /texto/i);
  assert.equal(r.sessionAfter?.stepId, stepAntes, 'mídia não avança nem regride a jornada');
  const ultimas = r.sessionAfter?.interactions.slice(-2) ?? [];
  assert.equal(ultimas[0]?.text, '[áudio]', 'a linha do tempo mostra que o lead mandou áudio');
  assert.equal(ultimas[1]?.action, 'unsupported_media');
});

test('primeiro contato por foto: pede texto E se apresenta — o lead precisa saber com quem fala', async () => {
  const p = phone(142);
  const r = await processWhatsappTurn(inbound('', { fromPhone: p, unsupportedType: 'image', messageId: 'wamid.IMG' }));

  assert.equal(r.action, 'unsupported_media');
  assert.match(r.replySent ?? '', /imagem/i);
  assert.match(r.replySent ?? '', /corretor digital/i, 'saudação vem junto no primeiro contato');
  assert.equal(r.sessionAfter?.stepId, 'service_type');
});
