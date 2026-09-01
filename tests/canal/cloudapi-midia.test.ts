/**
 * Mídia no webhook oficial: áudio/foto/arquivo NÃO somem mais em silêncio.
 * O parser marca o tipo e deixa o orquestrador responder; reação não é fala.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCloudApiInboundMessages } from '../../src/channels/whatsapp/cloudapi.js';

function payload(messages: unknown[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '5548991559679', phone_number_id: '1271003609430710' },
          contacts: [{ wa_id: '554888326647', profile: { name: 'Jera' } }],
          messages,
        },
      }],
    }],
  };
}

test('áudio vira inbound marcado, com texto vazio e o número da corretora', () => {
  const [m] = parseCloudApiInboundMessages(payload([
    { from: '554888326647', id: 'wamid.A1', timestamp: '1756512000', type: 'audio', audio: { id: 'x', mime_type: 'audio/ogg' } },
  ]));
  assert.ok(m, 'áudio não pode ser descartado');
  assert.equal(m.unsupportedType, 'audio');
  assert.equal(m.text, '');
  assert.equal(m.fromPhone, '554888326647');
  assert.equal(m.channelAccountId, '1271003609430710');
  assert.equal(m.messageId, 'wamid.A1');
});

test('imagem e documento também são marcados; texto segue normal; reação é ignorada', () => {
  const lista = parseCloudApiInboundMessages(payload([
    { from: '554888326647', id: 'wamid.I', timestamp: '1756512000', type: 'image', image: { id: 'i' } },
    { from: '554888326647', id: 'wamid.D', timestamp: '1756512001', type: 'document', document: { id: 'd' } },
    { from: '554888326647', id: 'wamid.T', timestamp: '1756512002', type: 'text', text: { body: 'oi' } },
    { from: '554888326647', id: 'wamid.R', timestamp: '1756512003', type: 'reaction', reaction: { emoji: '👍' } },
  ]));
  assert.deepEqual(lista.map((m) => m.unsupportedType ?? 'texto'), ['image', 'document', 'texto']);
  assert.equal(lista[2].text, 'oi');
});

test('texto vazio continua descartado — nada a responder', () => {
  const lista = parseCloudApiInboundMessages(payload([
    { from: '554888326647', id: 'wamid.V', timestamp: '1756512000', type: 'text', text: { body: '   ' } },
  ]));
  assert.equal(lista.length, 0);
});
