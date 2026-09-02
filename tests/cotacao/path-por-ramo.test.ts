/**
 * Path por ramo na camada Segfy + o runner residencial de ponta a ponta com dublês.
 * O default continua vehicle: nenhum caller do auto muda de path sem pedir.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDubles, installDubles, COBERTURA_RESIDENCIAL, respostasResidencial, showResultsMinimo } from './_dubles.js';

const d = createDubles();
installDubles(d);

const { postCalcular, segfyRamoPath } = await import('../../src/segfy/calcular.js');
const { getResultado } = await import('../../src/segfy/resultado.js');
const { getInsurersForVehicleType, getInsurersForResidence } = await import('../../src/segfy/companies.js');
const { runResidencialQuote } = await import('../../src/journey/residencialF1.js');

const COMPANY_LIST = { ok: true, status: 200, body: { data: [
  { id: '1', name: 'porto', commission: 15, nome_abreviado: 'Porto' },
  { id: '2', name: 'tokio', commission: 12, inativo: true },
  { id: '3', name: 'hdi', comissao: '20' },
] } };

test('segfyRamoPath monta o path versionado por ramo', () => {
  assert.equal(segfyRamoPath('vehicle', 'calculate'), '/api/vehicle/version/1.0/calculate');
  assert.equal(segfyRamoPath('residence', 'show-results'), '/api/residence/version/1.0/show-results');
});

test('postCalcular: default vehicle; residence troca só o path e mantém callback no config', async () => {
  d.calls.length = 0;
  d.reply = () => ({ ok: true, status: 200, body: { status: 'OK', guid: 'G' } });

  await postCalcular({ config: { insurers: [] }, data: {} }, 'CB-VEH');
  await postCalcular({ config: { insurers: [] }, data: {} }, 'CB-RES', 'residence');

  assert.equal(d.calls[0].path, '/api/vehicle/version/1.0/calculate');
  assert.equal(d.calls[1].path, '/api/residence/version/1.0/calculate');
  const body = d.calls[1].body as { config: { callback: string } };
  assert.equal(body.config.callback, 'CB-RES');
});

test('getResultado: default vehicle; residence troca o path com o mesmo body', async () => {
  d.calls.length = 0;
  d.reply = () => ({ ok: true, status: 200, body: {} });

  await getResultado({ guid: 'G1' });
  await getResultado('G2', 'residence');

  assert.equal(d.calls[0].path, '/api/vehicle/version/1.0/show-results');
  assert.equal(d.calls[1].path, '/api/residence/version/1.0/show-results');
  assert.deepEqual(d.calls[1].body, { data: { guid: 'G2', id: '', multicalculo_id: '' } });
});

test('company-list: vehicle manda vehicle_type; residence manda só o config (sem data)', async () => {
  d.calls.length = 0;
  d.reply = () => COMPANY_LIST;

  const veiculo = await getInsurersForVehicleType('car');
  const residencia = await getInsurersForResidence();

  assert.equal(d.calls[0].path, '/api/vehicle/version/1.0/company-list');
  assert.deepEqual(d.calls[0].body, { data: { vehicle_type: 'car' } });
  assert.equal(d.calls[1].path, '/api/residence/version/1.0/company-list');
  assert.deepEqual(d.calls[1].body, {}, 'residence não recebe vehicle_type');

  assert.deepEqual(residencia.map((i) => i.name), ['porto', 'hdi'], 'inativo sai da lista');
  assert.deepEqual(residencia.map((i) => i.commission), [15, 20]);
  assert.equal(veiculo.length, 2);

  // Cache por chave: segunda chamada não vai à rede.
  await getInsurersForResidence();
  assert.equal(d.calls.length, 2);
});

test('runResidencialQuote: socket antes do calculate, path residence, comissão do painel, ramo no resultado', async () => {
  d.calls.length = 0;
  d.closedSockets.length = 0;
  d.config = { coberturas: { residencial: COBERTURA_RESIDENCIAL }, comissoes: { residencial: 10 } };
  // Empresa que emitiu STEP já emitiu RESULT → a janela fecha no primeiro ciclo.
  d.socketEvents = [
    { action: 'STEP', data: { company: { name: 'porto' } } },
    { action: 'RESULT', data: { company: { name: 'porto' } } },
  ];
  d.reply = (path) => {
    if (path.endsWith('/calculate')) return { ok: true, status: 200, body: { status: 'OK', guid: 'GUID-RES' } };
    if (path.endsWith('/show-results')) return showResultsMinimo('GUID-RES');
    return { ok: false, status: 500, body: {} };
  };

  const r = await runResidencialQuote({ answers: respostasResidencial() }, 45000, 'test');

  assert.equal(r.ok, true);
  assert.equal(r.guid, 'GUID-RES');
  assert.equal(r.ramo, 'residencial');
  assert.equal(r.vehicleProfile, 'none');
  assert.equal(r.quoteRoomPath, '/quote-room/GUID-RES');
  assert.equal(r.events.result, 1);
  assert.equal(r.events.timedOut, false);
  assert.ok(r.quoteSummary.options.length >= 1);

  const paths = d.calls.map((c) => c.path);
  const calcIdx = paths.indexOf('/api/residence/version/1.0/calculate');
  assert.ok(calcIdx >= 0, 'calculate precisa ir no path do residence');
  assert.equal(paths.includes('/api/vehicle/version/1.0/calculate'), false, 'nada de vehicle numa cotação de imóvel');
  assert.ok(paths.indexOf('/api/residence/version/1.0/show-results') > calcIdx);

  const calc = d.calls[calcIdx].body as { config: { insurers: Array<{ name: string; commission: number }>; callback: string; reference: string } };
  assert.equal(calc.config.callback, r.callbackId);
  assert.match(calc.config.reference, /^robocote-res-/);
  assert.deepEqual(calc.config.insurers, [{ name: 'porto', commission: 10 }, { name: 'hdi', commission: 10 }], 'comissão do painel vale pra todas');
  assert.deepEqual(d.closedSockets, [`res_f1_${r.callbackId.slice(0, 8)}`]);
});

test('runResidencialQuote: sem comissão no painel usa a de cada seguradora; sem cobertura configurada falha antes da rede', async () => {
  d.calls.length = 0;
  d.config = { coberturas: { residencial: COBERTURA_RESIDENCIAL } };
  d.reply = (path) => {
    if (path.endsWith('/calculate')) return { ok: true, status: 200, body: { status: 'OK', guid: 'GUID-2' } };
    if (path.endsWith('/show-results')) return showResultsMinimo('GUID-2');
    return { ok: false, status: 500, body: {} };
  };

  await runResidencialQuote({ answers: respostasResidencial() }, 45000, 'test');
  const calc = d.calls.find((c) => c.path.endsWith('/calculate'))?.body as { config: { insurers: Array<{ commission: number }> } };
  assert.deepEqual(calc.config.insurers.map((i) => i.commission), [15, 20]);

  d.calls.length = 0;
  d.config = { coberturas: {} };
  await assert.rejects(runResidencialQuote({ answers: respostasResidencial() }, 45000, 'test'), /cobertura residencial/);
  assert.equal(d.calls.length, 0);
});

test('runResidencialQuote: calculate rejeitado fecha o socket como abortado e propaga o erro', async () => {
  d.closedSockets.length = 0;
  d.config = { coberturas: { residencial: COBERTURA_RESIDENCIAL } };
  d.reply = (path) => {
    if (path.endsWith('/calculate')) return { ok: true, status: 200, body: { status: 'VALIDACAO', validations: { 'residence.state': 'inválido' } } };
    return { ok: false, status: 500, body: {} };
  };

  await assert.rejects(runResidencialQuote({ answers: respostasResidencial() }, 45000, 'test'), /VALIDACAO/);
  assert.equal(d.closedSockets.length, 1);
  assert.match(d.closedSockets[0], /_aborted$/);
});
