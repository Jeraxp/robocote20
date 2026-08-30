/**
 * Idempotencia por wamid. A Meta re-entrega a mesma mensagem; o gateway pode
 * re-despachar. Processar duas vezes faria o lead ouvir a resposta repetida e a
 * jornada andar dois passos com uma frase so - o defeito mais caro que existe
 * aqui, porque nao parece defeito: parece o robo sendo burro.
 */

import './../_harness/env.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isMensagemRepetida, _limparDedup } from '../../src/channels/whatsapp/dedup.js';

beforeEach(() => _limparDedup());

test('o mesmo wamid duas vezes: a segunda e repetida', () => {
  assert.equal(isMensagemRepetida('wamid.AAA'), false, 'primeira vez e nova');
  assert.equal(isMensagemRepetida('wamid.AAA'), true, 'segunda vez e repetida');
  assert.equal(isMensagemRepetida('wamid.AAA'), true, 'e continua repetida');
});

test('wamids diferentes sao todos novos', () => {
  assert.equal(isMensagemRepetida('wamid.A'), false);
  assert.equal(isMensagemRepetida('wamid.B'), false);
  assert.equal(isMensagemRepetida('wamid.C'), false);
});

test('sem id nao da pra deduplicar - passa, nao bloqueia', () => {
  assert.equal(isMensagemRepetida(undefined), false);
  assert.equal(isMensagemRepetida(undefined), false);
  assert.equal(isMensagemRepetida(''), false);
  assert.equal(isMensagemRepetida('   '), false);
  assert.equal(isMensagemRepetida(null), false);
});

test('espaco em volta do id nao engana o dedup', () => {
  assert.equal(isMensagemRepetida('wamid.Z'), false);
  assert.equal(isMensagemRepetida('  wamid.Z  '), true);
});

test('a memoria nao cresce sem fim', () => {
  for (let i = 0; i < 7000; i++) isMensagemRepetida(`wamid.${i}`);
  // Os recentes continuam protegidos mesmo depois da poda.
  assert.equal(isMensagemRepetida('wamid.6999'), true);
});
