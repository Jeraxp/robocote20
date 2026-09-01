/**
 * Wording por ramo: quem cota MOTO não pode ouvir pergunta sobre "carro".
 *
 * O lead que lê "dirige o carro" no meio da cotação da moto corrige o robô em
 * vez de responder — e cada correção é um degrau a mais pro abandono. A tabela
 * de auto segue congelada (caracterização); moto/caminhão entram por troca de
 * locução completa, com artigo junto ("o carro"→"a moto", nunca "o moto").
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
const { applyRamoWording, ramoFromAnswers, STEP_PROMPT } = await import('../../src/core/conversation/steps.js');

// ─── unidade: a troca de locução ─────────────────────────────────────────────

test('auto passa intocado — é a tabela congelada', () => {
  for (const texto of Object.values(STEP_PROMPT)) {
    assert.equal(applyRamoWording(texto, 'auto'), texto);
  }
});

test('moto troca artigo junto: "o carro"→"a moto", sem produzir "o moto"', () => {
  const casos: Array<[string, string]> = [
    [STEP_PROMPT.vehicle_plate, 'placa da moto'],
    [STEP_PROMPT.is_main_driver, 'dirige a moto'],
    [STEP_PROMPT.young_driver, 'dirige essa moto'],
    [STEP_PROMPT.work_commute, 'Usa a moto'],
    [STEP_PROMPT.work_garage, 'deixar a moto'],
    [STEP_PROMPT.study_garage, 'deixar a moto'],
  ];
  for (const [texto, esperado] of casos) {
    const saida = applyRamoWording(texto, 'moto');
    assert.ok(saida.includes(esperado), `esperava "${esperado}" em: ${saida}`);
    assert.ok(!saida.includes('carro'), `sobrou "carro" em: ${saida}`);
    assert.ok(!saida.includes('o moto'), `artigo errado em: ${saida}`);
  }
});

test('caminhão mantém o artigo masculino', () => {
  const saida = applyRamoWording(STEP_PROMPT.is_main_driver, 'caminhao');
  assert.ok(saida.includes('dirige o caminhão'), saida);
  assert.ok(!saida.includes('carro'), saida);
});

test('ramoFromAnswers: sem escolha é auto; escolha cravada vence', () => {
  assert.equal(ramoFromAnswers({}), 'auto');
  assert.equal(ramoFromAnswers(undefined), 'auto');
  assert.equal(ramoFromAnswers({ insurance_branch: { rawValue: 'moto' } }), 'moto');
  assert.equal(ramoFromAnswers({ insurance_branch: { rawValue: 'caminhao' } }), 'caminhao');
  assert.equal(ramoFromAnswers({ insurance_branch: { rawValue: 'residencial' } }), 'auto', 'ramo desconhecido não quebra');
});

// ─── integração: a conversa de moto fala moto ────────────────────────────────

test('lead que escolheu moto ouve "placa da moto" depois do nome', async () => {
  ctrl.ramos = ['auto', 'moto'];
  const p = phone(130);
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));
  await processWhatsappTurn(inbound('1', { fromPhone: p })); // cotação → menu de ramos
  const escolha = await processWhatsappTurn(inbound('2', { fromPhone: p })); // moto

  assert.equal(escolha.action, 'branch_selected');
  assert.equal(escolha.sessionAfter?.answers.insurance_branch?.rawValue, 'moto');

  const nome = await processWhatsappTurn(inbound('Jera Souto', { fromPhone: p }));
  assert.ok(nome.replySent?.includes('placa da moto'), `esperava wording de moto, veio: ${nome.replySent}`);
  assert.ok(!nome.replySent?.includes('carro'), `sobrou "carro": ${nome.replySent}`);
});

test('lead que escolheu carro segue ouvindo "carro" — nada mudou pro auto', async () => {
  ctrl.ramos = ['auto', 'moto'];
  const p = phone(131);
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));
  await processWhatsappTurn(inbound('1', { fromPhone: p }));
  await processWhatsappTurn(inbound('1', { fromPhone: p })); // carro

  const nome = await processWhatsappTurn(inbound('Jera Souto', { fromPhone: p }));
  assert.ok(nome.replySent?.includes('placa do carro'), `wording de auto intacto, veio: ${nome.replySent}`);
});
