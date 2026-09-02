/**
 * Payload residencial: contrato EXATO do calculate residence.
 * Cada asserção aqui é um 422 que não vamos tomar em produção (sem sandbox na
 * Segfy, cada erro de payload seria uma cotação real errada).
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDubles, installDubles, COBERTURA_RESIDENCIAL, respostasResidencial } from './_dubles.js';

const d = createDubles();
installDubles(d);

const { buildResidencialPayload, deriveSum, parseMoney } = await import('../../src/journey/residencialF1.js');

const INSURERS = [{ name: 'porto', commission: 10 }];

type Payload = {
  config: { insurers: unknown; reference: string; callback: string };
  data: {
    quotation_id: string;
    quotation_date: string;
    validity_start: string;
    validity_end: string;
    renewal: Record<string, unknown>;
    customer: Record<string, unknown>;
    residence: Record<string, unknown>;
    coverage: Record<string, unknown>;
    questionnaire_residence: Record<string, boolean>;
  };
};

function montar(over: Record<string, string> = {}): Payload {
  return buildResidencialPayload(respostasResidencial(over), COBERTURA_RESIDENCIAL, INSURERS, 'CB-1', 'robocote-res-teste') as Payload;
}

test('customer: CPF vira pessoa física, celular é "celphone" (1 L) e documento só dígitos', () => {
  const { customer } = montar().data;
  assert.equal(customer.document, '12345678909');
  assert.equal(customer.type, 'private_individual');
  assert.equal(customer.sex, 'female');
  assert.equal(customer.name, 'Ana Ribeiro');
  assert.equal(customer.celphone, '48999991234');
  assert.equal('cellphone' in customer, false, 'grafia do vehicle não pode vazar pro residence');
  assert.equal(customer.birth_date, '1985-05-10');
});

test('customer: CNPJ vira pessoa jurídica', () => {
  const { customer } = montar({ document: '12.345.678/0001-95' }).data;
  assert.equal(customer.document, '12345678000195');
  assert.equal(customer.type, 'legal_entity');
});

test('renewal: seguro novo manda { insurer: "new" }; renovação segue o padrão do auto', () => {
  assert.deepEqual(montar().data.renewal, { insurer: 'new' });
  const renovacao = montar({ renewal_status: 'renewal', renewal_bonus: 'classe 5' }).data.renewal;
  assert.equal(renovacao.insurer, 'allianz');
  assert.equal(renovacao.bonus_current, '5');
  assert.ok(renovacao.prior_policy, 'renovação sem prior_policy toma 422');
});

test('residence: 10 obrigatórios com enums literais, tipo de logradouro separado do nome, UF em sigla', () => {
  const { residence } = montar().data;
  assert.deepEqual(residence, {
    zip_code: '88010400',
    segment: 'apartment',
    type_construction: 'masonry',
    type_residence: 'habitual',
    type_street: 'street',
    street: 'Felipe Schmidt',
    number: '100',
    complement: 'ap 302',
    neighborhood: 'Centro',
    city: 'Florianópolis',
    state: 'SC',
  });
});

test('residence: tipo de logradouro vindo do lookup (enum Segfy) prevalece sobre o prefixo', () => {
  const { residence } = montar({ res_street: 'das Flores', res_street_type: 'avenue' }).data;
  assert.equal(residence.type_street, 'avenue');
  assert.equal(residence.street, 'das Flores');
});

test('residence: sem complemento o campo não vai; enum fora da lista derruba antes da rede', () => {
  const { residence } = montar({ res_complement: '' }).data;
  assert.equal('complement' in residence, false);
  assert.throws(() => montar({ res_segment: 'casa' }), /res_segment/);
  assert.throws(() => montar({ res_construction: 'tijolo' }), /res_construction/);
});

test('coverage: sum derivado dos valores, fire = soma, 12 limites da corretora, assistência do painel', () => {
  const { coverage } = montar().data;
  assert.equal(coverage.sum, 'building_content');
  assert.equal(coverage.building_value, 300000);
  assert.equal(coverage.content_value, 50000);
  assert.equal(coverage.fire, 350000);
  assert.equal(coverage.assistance, 'basic');
  assert.deepEqual(
    [coverage.electrical_damages, coverage.pipes, coverage.rent_payment, coverage.glasses, coverage.recomposition_documents,
      coverage.family, coverage.theft, coverage.wind, coverage.vehicle_impact, coverage.moral_damages, coverage.landslip, coverage.earthquake],
    [5000, 3000, 3000, 2000, 1000, 30000, 10000, 20000, 10000, 5000, 0, 0],
  );
  // Os 14 obrigatórios do swagger, todos presentes.
  for (const campo of ['sum', 'electrical_damages', 'pipes', 'rent_payment', 'glasses', 'recomposition_documents', 'family',
    'theft', 'wind', 'vehicle_impact', 'fire', 'moral_damages', 'landslip', 'earthquake']) {
    assert.ok(campo in coverage, `coverage.${campo} é obrigatório`);
  }
});

test('coverage: só imóvel → building; só conteúdo → content; nenhum → erro', () => {
  const soImovel = montar({ res_content_value: '' }).data.coverage;
  assert.equal(soImovel.sum, 'building');
  assert.equal(soImovel.fire, 300000);
  assert.equal('content_value' in soImovel, false);

  const soConteudo = montar({ res_building_value: '0' }).data.coverage;
  assert.equal(soConteudo.sum, 'content');
  assert.equal(soConteudo.fire, 50000);
  assert.equal('building_value' in soConteudo, false);

  assert.throws(() => deriveSum(0, 0), /valor do imóvel/);
  assert.throws(() => montar({ res_building_value: '', res_content_value: '' }));
});

test('questionnaire_residence: 6 booleans dos answers; ausente = false (não afirma o que o lead não disse)', () => {
  assert.deepEqual(montar().data.questionnaire_residence, {
    condominium: true,
    alarm: false,
    window_grills: false,
    countryside: false,
    insured_owner: true,
    new_property: true,
  });
  const semRespostas = montar({ res_condominium: '', res_owner: '', res_new: '' }).data.questionnaire_residence;
  assert.equal(semRespostas.condominium, false);
  assert.equal(semRespostas.insured_owner, false);
  assert.equal(semRespostas.new_property, false);
});

test('config e datas: insurers/reference/callback e vigência de 1 ano', () => {
  const p = montar();
  assert.deepEqual(p.config, { insurers: INSURERS, reference: 'robocote-res-teste', callback: 'CB-1' });
  assert.equal(p.data.quotation_id, 'robocote-res-teste');
  assert.match(p.data.quotation_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.data.validity_start, p.data.quotation_date);
  assert.equal(Number(p.data.validity_end.slice(0, 4)), Number(p.data.validity_start.slice(0, 4)) + 1);
});

test('modo validação: obrigatório ausente é erro descritivo, nunca default silencioso', () => {
  assert.throws(() => montar({ res_number: '' }), /res_number/);
  assert.throws(() => montar({ res_zip: '123' }), /CEP/);
  assert.throws(() => montar({ document: '123' }), /CPF/);
  assert.throws(() => montar({ driver_sex: '' }), /driver_sex/);
});

test('parseMoney aceita dígitos, R$ formatado e "mil"', () => {
  assert.equal(parseMoney('350000'), 350000);
  assert.equal(parseMoney('R$ 350.000,00'), 350000);
  assert.equal(parseMoney('350 mil'), 350000);
  assert.equal(parseMoney('1.234.567'), 1234567);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney('abc'), 0);
});
