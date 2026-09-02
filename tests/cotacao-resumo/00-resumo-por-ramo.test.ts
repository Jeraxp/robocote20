/**
 * Quote Room por ramo: o normalizador do show-results precisa aguentar o shape
 * residencial (sem company_coverages, franquia ou FIPE) sem quebrar nem inventar,
 * e o contexto da cotação precisa carregar o ramo até a rota /resumo.
 * O caso auto fica congelado como caracterização — mudar o auto sem querer é regressão.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';

const ctrl = createCtrl();
installMocks(ctrl);

const { normalizeQuoteSummary, getQuoteSummary } = await import('../../src/quote/summary.js');
const { cacheQuoteContext, readQuoteContext } = await import('../../src/quote/contextCache.js');

type Envelope = { ok: true; status: number; contentType: string | null; timeMs: number; body: Record<string, unknown>; url: string; transport: 'body_config_token' };

function envelope(body: Record<string, unknown>): Envelope {
  return { ok: true, status: 200, contentType: 'application/json', timeMs: 1, body, url: 'mock', transport: 'body_config_token' };
}

/** Resultado auto como a produção devolve (subconjunto do dump real da Zurich/Porto). */
function fixtureAuto(): Record<string, unknown> {
  return {
    guid: 'GUID-AUTO',
    quotation_id: 'Q-AUTO',
    data: {
      data: {
        quotation_date: '2026-09-01',
        validity_budget: '2026-09-16',
        customer: { name: 'Ana Ribeiro' },
        vehicle: { brand: 'Fiat', model: 'Argo 1.0', model_year: 2022, manufacture_year: 2021, fipe_code: '001234-5', fipe_value: 72000 },
      },
    },
    results: [{
      results: [
        {
          status: 'success', premium: 3525.46, franchise: 2500, product: 'Auto Compreensiva', best_installment: 'Até 10x de R$ 352,54 1ª ADC/Carnê',
          result_id: 'r-zurich', company: { name: 'zurich', full_name: 'Zurich Seguros' },
          company_coverages: { coverage_type: 'Compreensiva', fipe_percentage: 100, assistence: '32 - Km Guincho ilimitado', glasses: 'Vidros básicos', rental_car: 'Não contratado', material_damage: 100000, body_injuries: 100000, moral_damage: 5000 },
          company_data: { pdf: 'https://x/pdf' },
        },
        {
          status: 'success', premium: 2900, franchise: 3000, product: 'Tradicional', best_installment: 'Até 4x sem juros',
          result_id: 'r-porto', company: { name: 'porto', full_name: 'Porto Seguro' },
          company_coverages: { coverage_type: 'Compreensiva', fipe_percentage: 100, assistence: '200 km', glasses: 'Não contratada', rental_car: 'Não contratado', material_damage: 50000, body_injuries: 50000, moral_damage: 0 },
        },
      ],
    }],
  };
}

/** Residencial MÍNIMO: só o que se pode assumir por analogia — sem company_coverages, franchise ou fipe. */
function fixtureResidencial(): Record<string, unknown> {
  return {
    guid: 'GUID-RES',
    id: 'Q-RES',
    data: {
      data: {
        quotation_date: '2026-09-01',
        customer: { name: 'Bruno Lima' },
        residence: { zip_code: '88010400', segment: 'apartment', street: 'Felipe Schmidt', number: '100', neighborhood: 'Centro', city: 'Florianópolis', state: 'SC' },
      },
    },
    results: [{
      results: [
        { status: 'success', premium: 480.5, product: 'Residencial Essencial', best_installment: 'Até 10x de R$ 48,05', result_id: 'r-porto-res', company: { name: 'porto', full_name: 'Porto Seguro' } },
        { status: 'success', premium: 610, product: 'Casa Protegida', result_id: 'r-hdi-res', company: { name: 'hdi', full_name: 'HDI Seguros' } },
        { status: 'error', premium: null, product: 'Recusado', result_id: 'r-erro', company: { name: 'azul' } },
        { status: 'additional_product', premium: 90, product: 'Assistência Residencial', result_id: 'r-adic', company: { name: 'porto' } },
      ],
    }],
  };
}

test('CARACTERIZACAO: resultado auto continua igual (ramo default, veículo, franquia e FIPE)', () => {
  const s = normalizeQuoteSummary(envelope(fixtureAuto()));

  assert.equal(s.ramo, 'auto');
  assert.equal(s.vehicle.label, 'Fiat 2022');
  assert.equal(s.vehicle.fipeCode, '001234-5');
  assert.equal(s.options.length, 2);
  const porto = s.options.find((o) => o.insurerKey === 'porto');
  assert.ok(porto);
  assert.equal(porto.rank, 1, 'mais barato ranqueia primeiro');
  assert.equal(porto.franchise, 3000);
  assert.equal(porto.coverage.fipePercentage, 100);
  assert.ok(porto.badges.includes('100% FIPE'));
  assert.equal(porto.paymentSummary, 'Até 4x sem juros');
  const zurich = s.options.find((o) => o.insurerKey === 'zurich');
  assert.ok(zurich);
  assert.equal(zurich.coverage.assistance, 'Km Guincho ilimitado', 'código numérico da assistência some');
  assert.ok(zurich.hasPdf);
  assert.equal(s.recommendations.length, 3);
  assert.equal(s.customer.firstName, 'Ana');
});

test('residencial sem company_coverages/franquia/fipe não quebra nem inventa', () => {
  const s = normalizeQuoteSummary(envelope(fixtureResidencial()), undefined, 'Robocote', 'residencial');

  assert.equal(s.ramo, 'residencial');
  assert.equal(s.guid, 'GUID-RES');
  assert.equal(s.quotationId, 'Q-RES');
  assert.equal(s.options.length, 3, 'erro cai fora; principal e adicional ficam');
  for (const o of s.options) {
    assert.ok(o.productName, 'productName obrigatório');
    assert.ok(o.annualPremium > 0, 'annualPremium obrigatório');
    assert.ok(o.category === 'principal' || o.category === 'adicional');
    assert.equal(o.franchise, null, 'franquia ausente vira null, não 0');
    assert.equal(o.coverage.fipePercentage, null, 'FIPE não existe em residencial');
    assert.equal(o.coverage.materialDamage, null);
    assert.equal(o.coverage.isComprehensive, false);
    assert.ok(!o.badges.some((b) => /fipe|compreensiva|franquia/i.test(b)), `badge de auto vazou: ${o.badges.join(',')}`);
    assert.ok(!/fipe|franquia/i.test(o.consultativeNote), `nota de auto vazou: ${o.consultativeNote}`);
    assert.ok(!o.attentionPoints.some((p) => /fipe|danos materiais|mais ampla/i.test(p)), `ponto de atenção de auto vazou: ${o.attentionPoints.join('|')}`);
  }
  const principais = s.options.filter((o) => o.category === 'principal');
  assert.equal(principais.length, 2);
  assert.equal(s.metrics.principalCount, 2);
  assert.equal(s.metrics.additionalCount, 1);
  assert.equal(s.metrics.minPremium, 90);
});

test('residencial: bloco do bem vira rótulo de imóvel com endereço curto, sem número', () => {
  const s = normalizeQuoteSummary(envelope(fixtureResidencial()), undefined, 'Robocote', 'residencial');

  assert.equal(s.vehicle.label, 'Imóvel');
  assert.equal(s.vehicle.brand, 'Apartamento');
  assert.equal(s.vehicle.model, 'Felipe Schmidt · Centro · Florianópolis/SC');
  assert.ok(!s.vehicle.model.includes('100'), 'número do imóvel não vai pra sala compartilhável');
  assert.equal(s.vehicle.fipeCode, '');
  assert.equal(s.vehicle.fipeValue, null);
  assert.equal(s.vehicle.modelYear, null);
});

test('residencial: recomendações não exigem compreensiva/FIPE — menor prêmio é a porta de entrada', () => {
  const s = normalizeQuoteSummary(envelope(fixtureResidencial()), { firstName: 'Bruno', coveragePreference: 'Economia' }, 'Robocote', 'residencial');

  const cheap = s.recommendations.find((r) => r.role === 'cheap');
  assert.ok(cheap);
  assert.equal(cheap.optionId, 'r-porto-res', 'menor prêmio entre as principais, nunca o adicional');
  for (const r of s.recommendations) {
    assert.ok(s.options.some((o) => o.id === r.optionId), 'toda recomendação aponta pra opção existente');
    assert.ok(!/fipe|compreensiva|franquia/i.test(r.reason), `razão de auto vazou: ${r.reason}`);
  }
  assert.ok(!s.advisor.bullets.some((b) => /fipe|franquia|roubo\/inc/i.test(b)), `bullet de auto vazou: ${s.advisor.bullets.join('|')}`);
  assert.match(s.advisor.summary, /^Bruno, /);
});

test('residencial: chaves de endereço em português também são reconhecidas', () => {
  const body = fixtureResidencial();
  (body.data as { data: Record<string, unknown> }).data.residence = { segment: 'house', logradouro: 'Rua das Flores', bairro: 'Trindade', cidade: 'Florianópolis', uf: 'SC' };
  const s = normalizeQuoteSummary(envelope(body), undefined, 'Robocote', 'residencial');
  assert.equal(s.vehicle.brand, 'Casa');
  assert.equal(s.vehicle.model, 'Rua das Flores · Trindade · Florianópolis/SC');
});

test('residencial sem bloco de imóvel no retorno degrada pra rótulo vazio, sem lançar', () => {
  const body = fixtureResidencial();
  delete (body.data as { data: Record<string, unknown> }).data.residence;
  const s = normalizeQuoteSummary(envelope(body), undefined, 'Robocote', 'residencial');
  assert.equal(s.vehicle.label, 'Imóvel');
  assert.equal(s.vehicle.model, '');
});

test('sem nenhuma opção calculada, lança sem citar fornecedor', () => {
  assert.throws(
    () => normalizeQuoteSummary(envelope({ guid: 'x', results: [] }), undefined, 'Robocote', 'residencial'),
    (e: Error) => !/segfy/i.test(e.message),
  );
});

test('contexto da cotação grava e devolve o ramo; sem ramo vale auto', () => {
  cacheQuoteContext('g-res', { firstName: 'Bruno', coveragePreference: null }, 'tenant-1', 'residencial');
  cacheQuoteContext('g-auto', { firstName: 'Ana', coveragePreference: 'Proteção' }, 'tenant-1');

  const res = readQuoteContext('g-res');
  assert.ok(res);
  assert.equal(res.ramo, 'residencial');
  assert.equal(res.tenantId, 'tenant-1');
  assert.equal(res.info.firstName, 'Bruno');

  const auto = readQuoteContext('g-auto');
  assert.ok(auto);
  assert.equal(auto.ramo, 'auto');
  assert.equal(readQuoteContext('nunca-visto'), undefined);
});

test('getQuoteSummary residencial busca o show-results no path do ramo residence', async () => {
  ctrl.segfyCalls.length = 0;
  ctrl.segfyReply = envelope(fixtureResidencial());

  const s = await getQuoteSummary('GUID-RES', undefined, 'Robocote', 'residencial');

  assert.equal(s.ramo, 'residencial');
  assert.equal(ctrl.segfyCalls.length, 1);
  assert.match(ctrl.segfyCalls[0].path, /\/api\/residence\/version\/1\.0\/show-results$/);
});

test('getQuoteSummary sem ramo continua no path vehicle (moto e caminhão idem)', async () => {
  ctrl.segfyCalls.length = 0;
  ctrl.segfyReply = envelope(fixtureAuto());

  await getQuoteSummary('GUID-AUTO');
  await getQuoteSummary('GUID-AUTO', undefined, 'Robocote', 'moto');

  assert.equal(ctrl.segfyCalls.length, 2);
  for (const call of ctrl.segfyCalls) {
    assert.match(call.path, /\/api\/vehicle\/version\/1\.0\/show-results$/);
  }
});
