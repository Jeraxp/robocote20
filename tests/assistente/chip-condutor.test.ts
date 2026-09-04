/**
 * O chip "Outra pessoa" virava "Sim, sou eu" — e a seguradora recebia o
 * condutor errado. Causa: o atalho 's' (de "sim") casava DENTRO de "pessoa".
 * Dado errado que ninguém vê acontecer é o defeito mais caro que temos.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAutoF1AssistantMessage } from '../../src/assistant/autoF1.js';

async function responde(stepId: string, message: string) {
  return handleAutoF1AssistantMessage({
    message,
    channel: 'webchat',
    tenantId: 'test',
    snapshot: { stepId, completed: false, answers: {}, recentMessages: [] } as never,
    catalogContext: { items: [] },
  } as never);
}

test('"Outra pessoa" é NÃO — o título do chip precisa voltar como o lead quis dizer', async () => {
  const r = await responde('is_main_driver', 'Outra pessoa');
  assert.equal(r.proposedAnswer?.value, 'no');
});

test('"Sim, sou eu" continua sendo sim', async () => {
  const r = await responde('is_main_driver', 'Sim, sou eu');
  assert.equal(r.proposedAnswer?.value, 'yes');
});

test('atalhos de uma letra ainda funcionam sozinhos', async () => {
  assert.equal((await responde('is_main_driver', 's')).proposedAnswer?.value, 'yes');
  assert.equal((await responde('is_main_driver', 'n')).proposedAnswer?.value, 'no');
});

test('outros títulos de chip voltam no valor certo', async () => {
  for (const [step, titulo, esperado] of [
    ['res_segment', 'Apartamento', 'apartment'],
    ['res_construction', 'Alvenaria', 'masonry'],
    ['res_residence_type', 'Veraneio', 'summer_house'],
    ['residence_garage', 'Não tenho', 'no_garage'],
    ['marital_status', 'Solteiro(a)', 'single'],
    ['driver_sex', 'Feminino', 'female'],
    ['renewal_status', 'Seguro novo', 'new'],
  ] as const) {
    const r = await responde(step, titulo);
    assert.equal(r.proposedAnswer?.value, esperado, `chip "${titulo}" no step ${step}`);
  }
});
