/**
 * Regras locais do assistente na jornada residencial (revisão de b72d9ac):
 * cada uma destas mandava dado ERRADO pra cotação real — sem sandbox.
 *  - "tô em SC" virava Tocantins (primeira partícula de 2 letras vencia).
 *  - inquilino não conseguia dizer "não seguro a construção" (loop de valor).
 *  - "não tem" virava o complemento do imóvel.
 * IA desligada pelo harness → o caminho é localRules, determinístico.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAutoF1AssistantMessage } from '../../src/assistant/autoF1.js';

async function responde(stepId: string, message: string, answers: Record<string, { id: string; label: string; value: string; rawValue?: string }> = {}) {
  return handleAutoF1AssistantMessage({
    message,
    channel: 'whatsapp',
    tenantId: 'test',
    snapshot: { stepId, completed: false, answers, recentMessages: [] } as never,
    catalogContext: { items: [] },
  } as never);
}

test('UF: a sigla do fim vence a partícula do começo — "tô em SC" é Santa Catarina', async () => {
  for (const [fala, uf] of [['tô em SC', 'SC'], ['to em sp', 'SP'], ['se for SC', 'SC'], ['ES', 'ES'], ['santa catarina', 'SC'], ['fica no pa', 'PA']] as const) {
    const r = await responde('res_state', fala);
    assert.equal(r.action, 'answer_step', `"${fala}" deveria responder`);
    assert.equal(r.proposedAnswer?.value, uf, `"${fala}" → ${uf}`);
  }
});

test('valor da construção: "não tenho, só o conteúdo" vira zero em vez de loop', async () => {
  for (const fala of ['não tenho, só quero o conteúdo', 'zero', '0', 'nenhum', 'não']) {
    const r = await responde('res_building_value', fala);
    assert.equal(r.action, 'answer_step', `"${fala}" não pode virar pergunta de novo`);
    assert.equal(r.proposedAnswer?.value, '0');
  }
  const ok = await responde('res_building_value', '350 mil');
  assert.equal(ok.proposedAnswer?.value, '350000');
});

test('complemento: "não tem" é ausência de complemento, não um complemento chamado "não tem"', async () => {
  const r = await responde('res_complement', 'não tem');
  assert.equal(r.action, 'answer_step');
  assert.equal(r.proposedAnswer?.value, '');
  const apto = await responde('res_complement', 'apto 302');
  assert.equal(apto.proposedAnswer?.value, 'apto 302');
});

test('número: "sem número" vira S/N; texto sem dígito pede de novo', async () => {
  const sn = await responde('res_number', 'sem número');
  assert.equal(sn.proposedAnswer?.value, 'S/N');
  const num = await responde('res_number', '100A');
  assert.equal(num.proposedAnswer?.value, '100A');
  const ruim = await responde('res_number', 'do lado da padaria');
  assert.equal(ruim.action, 'ask_clarification');
});
