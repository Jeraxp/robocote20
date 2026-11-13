/**
 * Contrato Segfy: o pedido que o motor monta tem de caber no schema vivo do
 * POST /api/vehicle/version/1.0/calculate (swagger de 12/11/2026). Sem sandbox
 * na Segfy, um código fora do enum vira 422 (ou cotação errada) em produção.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDubles, installDubles } from './_dubles.js';
import { checkAgainstSchema } from '../_harness/jsonSchemaCheck.js';

const d = createDubles();
installDubles(d);

const { buildAutoF1Payload } = await import('../../src/journey/autoF1.js');

const schema = JSON.parse(
  readFileSync(new URL('../_fixtures/segfy/vehicle-calculate.request.schema.json', import.meta.url), 'utf8'),
) as object;

const COBERTURA = {
  tipo_cobertura: 'comprehensive',
  tabela_fipe: 100,
  franquia: 'normal',
  isencao_franquia: false,
  vidros: 'glass_basic_referenced',
  assistencia_24h: 'assistance_200_km_referenced',
  carro_reserva: 'rental_car_07_days_referenced',
  tipo_carro_reserva: 'basic',
  reposicao_zero_km: 'no_replacement',
  rcf_dm: 100000,
  rcf_dc: 100000,
  danos_morais: 20000,
  app_morte: 10000,
  desp_extras: 0,
};
const SEGURADORAS = [{ name: 'porto', commission: 10 }];

function respostas(over: Record<string, string> = {}) {
  return {
    answers: {
      name: 'Ana Ribeiro',
      mode: 'real',
      insurance_branch: 'auto',
      vehicle_brand: '59',
      vehicle_brand_text: 'VW - VolksWagen',
      vehicle_year: '2020',
      vehicle_model: '5940',
      vehicle_model_text: 'Gol 1.6 MSI',
      vehicle_model_id: '5940',
      vehicle_fipe_code: '005340-6',
      vehicle_fipe_value: '48000',
      vehicle_fuel_type: 'flex',
      usage: 'Particular',
      renewal_status: 'new',
      renewal_bonus: '',
      zip_code: '88010-400',
      residence_type: 'apartment',
      // Códigos como a jornada os entrega ao motor (opções do assistente/WhatsApp):
      // 'Viúvo(a)' e 'Sim, sem portão eletrônico'.
      residence_garage: 'yes_no_electronic_gate',
      marital_status: 'widowed',
      coverage: 'completa',
      contact: '(48) 99999-1234',
      driver_birth_date: '10/05/1985',
      driver_sex: 'female',
      document: '123.456.789-09',
      is_main_driver: 'yes',
      main_driver_document: '',
      main_driver_name: '',
      main_driver_birth_date: '',
      main_driver_sex: '',
      young_driver: 'no',
      studies: 'no',
      study_garage: 'no',
      work_commute: 'no',
      work_garage: 'no',
      monthly_km: '1000',
      ...over,
    },
  };
}

// O token da Segfy entra no envio (segfy/calcular.ts), não no montador: o teste
// confere o corpo exatamente como o motor o monta, mais o token que o cliente injeta.
function corpo(payload: object): unknown {
  const p = payload as { config: Record<string, unknown> };
  return { ...p, config: { ...p.config, token: 'token-do-envio' } };
}

test('pedido de carro montado pelo motor cumpre o contrato da Segfy', () => {
  const { payload } = buildAutoF1Payload(respostas(), 'callback-teste', {
    coverage: COBERTURA,
    insurers: SEGURADORAS,
    vehicleType: 'car',
  });
  assert.deepEqual(checkAgainstSchema(corpo(payload), schema), []);
});

test('pedido de moto montado pelo motor cumpre o contrato da Segfy', () => {
  const { payload } = buildAutoF1Payload(
    respostas({
      insurance_branch: 'moto',
      vehicle_model_text: 'CG 160 Start',
      vehicle_fipe_code: '827010-7',
      vehicle_fipe_value: '15000',
      vehicle_fuel_type: 'gasoline',
      marital_status: 'Casado(a)',
      residence_garage: 'Sim, com portão eletrônico',
    }),
    'callback-teste',
    { coverage: COBERTURA, insurers: SEGURADORAS, vehicleType: 'motorcycle' },
  );
  assert.deepEqual(checkAgainstSchema(corpo(payload), schema), []);
});

test('rótulos do cliente e códigos legados caem nos códigos vivos do contrato', () => {
  const montar = (over: Record<string, string>) =>
    buildAutoF1Payload(respostas(over), 'callback-teste', { coverage: COBERTURA, insurers: SEGURADORAS, vehicleType: 'car' }).payload
      .data as { main_driver: { marital_status: string }; questionnaire: { residence_garage: string } };

  for (const estadoCivil of ['Viúvo(a)', 'widowed', 'widower']) {
    assert.equal(montar({ marital_status: estadoCivil }).main_driver.marital_status, 'widower', estadoCivil);
  }
  for (const garagem of ['Sim, sem portão eletrônico', 'yes_no_electronic_gate', 'yes_without_electronic_gate']) {
    assert.equal(montar({ residence_garage: garagem }).questionnaire.residence_garage, 'yes_without_electronic_gate', garagem);
  }
  assert.equal(montar({ residence_garage: 'Sim, com portão eletrônico' }).questionnaire.residence_garage, 'yes_with_electronic_gate');
});
