/**
 * Lookup de CEP: a resposta do zip-code não é documentada — o parser precisa
 * engolir PT e EN, envelope ou plano, e o tipo de logradouro sai do prefixo.
 * E lookupCep NUNCA lança: quem chama pergunta o endereço ao lead.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDubles, installDubles } from './_dubles.js';

const d = createDubles();
installDubles(d);

const { lookupCep, parseCepResponse, splitStreetType, normalizeUf } = await import('../../src/segfy/cep.js');

test('splitStreetType: prefixos em português viram o enum Segfy e saem do nome', () => {
  assert.deepEqual(splitStreetType('Rua das Flores'), { streetType: 'street', street: 'das Flores' });
  assert.deepEqual(splitStreetType('Avenida Paulista'), { streetType: 'avenue', street: 'Paulista' });
  assert.deepEqual(splitStreetType('Av. Beira Mar Norte'), { streetType: 'avenue', street: 'Beira Mar Norte' });
  assert.deepEqual(splitStreetType('Travessa São José'), { streetType: 'platter', street: 'São José' });
  assert.deepEqual(splitStreetType('Alameda Santos'), { streetType: 'lane', street: 'Santos' });
  assert.deepEqual(splitStreetType('Rodovia BR-101'), { streetType: 'highway', street: 'BR-101' });
  assert.deepEqual(splitStreetType('Estrada do Sol'), { streetType: 'road', street: 'do Sol' });
  assert.deepEqual(splitStreetType('Praça XV de Novembro'), { streetType: 'square', street: 'XV de Novembro' });
  assert.deepEqual(splitStreetType('Largo da Alfândega'), { streetType: 'plain', street: 'da Alfândega' });
});

test('splitStreetType: prefixo desconhecido → others com o nome inteiro', () => {
  assert.deepEqual(splitStreetType('Servidão Mangueiras'), { streetType: 'others', street: 'Servidão Mangueiras' });
  assert.deepEqual(splitStreetType('Beco do Batman'), { streetType: 'others', street: 'Beco do Batman' });
  assert.deepEqual(splitStreetType('Rua'), { streetType: 'others', street: 'Rua' });
});

test('parseCepResponse: chaves em PT dentro de { data }', () => {
  const r = parseCepResponse({
    status: 'OK',
    data: { cep: '88010-400', logradouro: 'Rua Felipe Schmidt', bairro: 'Centro', localidade: 'Florianópolis', uf: 'SC' },
  });
  assert.deepEqual(r, { street: 'Felipe Schmidt', neighborhood: 'Centro', city: 'Florianópolis', state: 'SC', streetType: 'street' });
});

test('parseCepResponse: chaves em EN, objeto plano, estado por extenso', () => {
  const r = parseCepResponse({ street: 'Avenida Paulista', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'São Paulo' });
  assert.deepEqual(r, { street: 'Paulista', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP', streetType: 'avenue' });
});

test('parseCepResponse: tipo de logradouro explícito da API prevalece (enum ou rótulo PT)', () => {
  const enumEn = parseCepResponse({ data: { street: 'das Flores', street_type: 'avenue', city: 'X', state: 'sc' } });
  assert.equal(enumEn?.streetType, 'avenue');
  assert.equal(enumEn?.street, 'das Flores');
  const rotuloPt = parseCepResponse({ data: { logradouro: 'das Flores', tipo_logradouro: 'Travessa', cidade: 'X', estado: 'SC' } });
  assert.equal(rotuloPt?.streetType, 'platter');
  assert.equal(rotuloPt?.street, 'das Flores');
});

test('parseCepResponse: lista em data, envelope duplo e corpo sem endereço', () => {
  const lista = parseCepResponse({ data: [{ logradouro: 'Rua A', bairro: 'B', cidade: 'C', uf: 'rs' }] });
  assert.equal(lista?.street, 'A');
  assert.equal(lista?.state, 'RS');
  const duplo = parseCepResponse({ data: { data: { street: 'Rua Z', city: 'Y', state: 'PR' } } });
  assert.equal(duplo?.city, 'Y');
  assert.equal(parseCepResponse({ status: 'OK', data: {} }), null);
  assert.equal(parseCepResponse({ status: 'ERROR', message: 'CEP não encontrado' }), null);
  assert.equal(parseCepResponse('texto'), null);
  assert.equal(parseCepResponse(null), null);
});

test('parseCepResponse: campo faltante vem vazio (a jornada pergunta), não inventado', () => {
  const r = parseCepResponse({ data: { localidade: 'Brasília', uf: 'DF' } });
  assert.deepEqual(r, { street: '', neighborhood: '', city: 'Brasília', state: 'DF' });
});

test('normalizeUf: sigla em maiúsculo, nome por extenso vira sigla', () => {
  assert.equal(normalizeUf('sc'), 'SC');
  assert.equal(normalizeUf('Santa Catarina'), 'SC');
  assert.equal(normalizeUf('Espírito Santo'), 'ES');
  assert.equal(normalizeUf(''), '');
});

test('lookupCep: bate no zip-code do residence com o CEP só em dígitos', async () => {
  d.calls.length = 0;
  d.reply = () => ({ ok: true, status: 200, body: { status: 'OK', data: { logradouro: 'Rua Felipe Schmidt', bairro: 'Centro', localidade: 'Florianópolis', uf: 'SC' } } });

  const r = await lookupCep('88010-400');

  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].path, '/api/residence/version/1.0/zip-code');
  assert.deepEqual(d.calls[0].body, { data: { zip_code: '88010400' } });
  assert.equal(r?.street, 'Felipe Schmidt');
  assert.equal(r?.streetType, 'street');
});

test('lookupCep nunca lança: CEP inválido não vai à rede; erro de rede e HTTP não-ok viram null', async () => {
  d.calls.length = 0;
  assert.equal(await lookupCep('123'), null);
  assert.equal(await lookupCep(''), null);
  assert.equal(d.calls.length, 0, 'CEP inválido não pode gastar chamada');

  d.reply = () => { throw new Error('rede caiu'); };
  assert.equal(await lookupCep('88010400'), null);

  d.reply = () => ({ ok: false, status: 422, body: { status: 'VALIDACAO' } });
  assert.equal(await lookupCep('88010400'), null);

  d.reply = () => ({ ok: true, status: 200, body: '<html>proxy</html>' });
  assert.equal(await lookupCep('88010400'), null);
});
