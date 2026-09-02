/**
 * Jornada RESIDENCIAL em modo validação (decisão Jera 01/09): o primeiro ramo
 * fora de veículo. Menu, escolha por número/palavra, CEP que preenche o
 * endereço pelo lead (e pula 4 perguntas), CEP que não acha (e pergunta),
 * e o cálculo que sai pelo motor `residence` com os valores crus da conversa.
 */

import './../_harness/env.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';
import { inbound, phone } from '../_harness/fixtures.js';

const ctrl = createCtrl();
ctrl.aiAutoAccept = true;
installMocks(ctrl);

const { processWhatsappTurn } = await import('../../src/channels/whatsapp/orchestrator.js');

beforeEach(() => {
  ctrl.ramos = ['auto', 'residencial'];
  ctrl.cepResult = null;
  ctrl.residencialQuoteRequest = null;
  ctrl.quoteMode = 'ok';
});

async function ateMenu(p: string): Promise<string> {
  await processWhatsappTurn(inbound('oi', { fromPhone: p }));
  const r = await processWhatsappTurn(inbound('1', { fromPhone: p }));
  return r.replySent ?? '';
}

test('com residencial ativo, o menu oferece "Seguro Residencial"', async () => {
  const menu = await ateMenu(phone(150));
  assert.match(menu, /Seguro Residencial/);
  assert.match(menu, /Seguro de Carro/);
});

test('escolha por número e por palavra ("casa", "apartamento") crava o ramo residencial', async () => {
  const casos: Array<[number, string]> = [[151, '2'], [152, 'casa'], [153, 'quero segurar meu apartamento']];
  for (const [n, fala] of casos) {
    const p = phone(n);
    await ateMenu(p);
    const r = await processWhatsappTurn(inbound(fala, { fromPhone: p }));
    assert.equal(r.action, 'branch_selected', `falha em "${fala}"`);
    assert.equal(r.sessionAfter?.answers.insurance_branch?.rawValue, 'residencial');
    assert.match(r.replySent ?? '', /residencial/i);
    assert.equal(r.sessionAfter?.stepId, 'name');
  }
});

test('CEP encontrado: endereço entra com procedência de lookup e as 4 perguntas somem', async () => {
  const p = phone(154);
  await ateMenu(p);
  await processWhatsappTurn(inbound('2', { fromPhone: p }));
  await processWhatsappTurn(inbound('Jera Souto', { fromPhone: p }));
  ctrl.cepResult = { street: 'Felipe Schmidt', neighborhood: 'Centro', city: 'Florianópolis', state: 'sc', streetType: 'street' };

  const r = await processWhatsappTurn(inbound('88010400', { fromPhone: p }));

  assert.match(r.replySent ?? '', /Achei o endereço/);
  assert.match(r.replySent ?? '', /Florianópolis\/SC/);
  assert.match(r.replySent ?? '', /número do imóvel/i, 'pula direto pro número');
  assert.equal(r.sessionAfter?.stepId, 'res_number');
  const a = r.sessionAfter?.answers ?? {};
  assert.equal(a.res_state?.rawValue, 'SC');
  assert.equal(a.res_city?.rawValue, 'Florianópolis');
  assert.equal((a.res_street?.metadata as { source?: string } | undefined)?.source, 'lookup', 'procedência marcada');
  assert.equal(a.res_street?.label, 'Endereço (pelo CEP)');
});

test('CEP não encontrado: a jornada pergunta a rua — sem inventar endereço', async () => {
  const p = phone(155);
  await ateMenu(p);
  await processWhatsappTurn(inbound('2', { fromPhone: p }));
  await processWhatsappTurn(inbound('Jera Souto', { fromPhone: p }));
  ctrl.cepResult = null;

  const r = await processWhatsappTurn(inbound('88010400', { fromPhone: p }));

  assert.equal(r.sessionAfter?.stepId, 'res_street');
  assert.match(r.replySent ?? '', /nome da rua/i);
  assert.equal(r.sessionAfter?.answers.res_street, undefined);
});

test('jornada inteira até o cálculo: o motor residencial recebe os valores crus da conversa', async () => {
  const p = phone(156);
  await ateMenu(p);
  await processWhatsappTurn(inbound('2', { fromPhone: p }));
  ctrl.cepResult = { street: 'das Flores', neighborhood: 'Trindade', city: 'Florianópolis', state: 'SC', streetType: 'street' };
  const falas = [
    'Jera Souto',      // name
    '88040000',        // res_zip → lookup preenche rua/bairro/cidade/UF
    '100',             // res_number
    'apto 301',        // res_complement
    'apartamento',     // res_segment
    'alvenaria',       // res_construction
    'habitual',        // res_residence_type
    '350000',          // res_building_value
    '50000',           // res_content_value
    'sim',             // res_condominium
    'não',             // res_alarm
    'não',             // res_grills
    'não',             // res_countryside
    'sim',             // res_owner
    'sim',             // res_new
    'novo',            // renewal_status
    '48999998888',     // contact
    'masculino',       // driver_sex
    '12345678909',     // document
  ];
  let ultimo = null as Awaited<ReturnType<typeof processWhatsappTurn>> | null;
  for (const fala of falas) {
    ultimo = await processWhatsappTurn(inbound(fala, { fromPhone: p }));
  }
  assert.ok(ultimo, 'jornada rodou');
  assert.ok(['quote_link', 'complete'].includes(String(ultimo?.sessionAfter?.stepId)), `parou em ${ultimo?.sessionAfter?.stepId}`);

  const calc = await processWhatsappTurn(inbound('pode', { fromPhone: p }));
  assert.ok(ctrl.residencialQuoteRequest, 'runner residencial foi chamado');
  const req = ctrl.residencialQuoteRequest as { answers: Record<string, string> };
  assert.equal(req.answers.insurance_branch, 'residencial');
  assert.equal(req.answers.res_city, 'Florianópolis');
  assert.equal(req.answers.res_number, '100');
  assert.equal(req.answers.document, '12345678909');
  assert.match(calc.replySent ?? '', /Cotação pronta|detalhes/i);
  assert.match(calc.replySent ?? '', /\/quote-room\/GUID-RES-TESTE\?ramo=residencial/, 'o ramo viaja na URL da sala — o cache morre no deploy');
});

test('CEP geral de município (sem rua): confirma só cidade/UF e pergunta a rua', async () => {
  const p = phone(158);
  await ateMenu(p);
  await processWhatsappTurn(inbound('2', { fromPhone: p }));
  await processWhatsappTurn(inbound('Jera Souto', { fromPhone: p }));
  ctrl.cepResult = { street: '', neighborhood: '', city: 'Lages', state: 'SC' };

  const r = await processWhatsappTurn(inbound('88500000', { fromPhone: p }));

  assert.match(r.replySent ?? '', /Achei o endereço: Lages\/SC\./, 'sem vírgula solta, sem travessão pendurado');
  assert.equal(r.sessionAfter?.stepId, 'res_street');
});

test('sem contato explícito, o WhatsApp da conversa vira o contato do payload', async () => {
  const p = phone(159);
  await ateMenu(p);
  await processWhatsappTurn(inbound('2', { fromPhone: p }));
  // Semeia a sessão direto no fim da jornada: só o cálculo importa aqui.
  const { sessionStore } = await import('../../src/session/store.js');
  const key = { tenantId: 'test', channel: 'whatsapp' as const, channelUserId: p };
  const s = await sessionStore.get(key);
  assert.ok(s);
  await sessionStore.upsert({ ...s, stepId: 'quote_link' });
  await processWhatsappTurn(inbound('pode', { fromPhone: p }));
  const req = ctrl.residencialQuoteRequest as { answers: Record<string, string> } | null;
  assert.equal(req?.answers.contact, p);
});

test('cotação de auto continua saindo pelo motor de veículo — nada vazou entre ramos', async () => {
  const p = phone(157);
  await ateMenu(p);
  const r = await processWhatsappTurn(inbound('1', { fromPhone: p }));
  assert.equal(r.sessionAfter?.answers.insurance_branch?.rawValue, 'auto');
  assert.equal(ctrl.residencialQuoteRequest, null);
});
