/**
 * Botões no WhatsApp oficial (contrato v3). O núcleo fala texto; o adaptador
 * decide o que vira botão, lista ou botão-link — e o que segue como texto.
 * Também: o toque em botão volta como FALA (título), nunca como mídia; e o
 * envio cai pro texto quando o gateway recusa — a fala nunca se perde.
 */

import './../_harness/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { planejarInterativo, LIMITES } from '../../src/channels/whatsapp/interativo.js';
import { SERVICE_TYPE_QUESTION, buildBranchQuestion, buildGreeting } from '../../src/core/conversation/language.js';
import { STEP_PROMPT } from '../../src/core/conversation/steps.js';
import { parseCloudApiInboundMessages } from '../../src/channels/whatsapp/cloudapi.js';
import { sendWhatsappInteractive, hasInteractive, _limparCapacidade } from '../../src/channels/whatsapp/gateway.js';

// ─── o que vira botão ────────────────────────────────────────────────────────

test('a saudação (triagem 1/2) vira dois botões e o corpo perde as linhas numeradas', () => {
  const plano = planejarInterativo(buildGreeting('Robocote').join('\n\n'));
  assert.ok(plano && plano.tipo === 'botoes', 'triagem tem 2 opções → botões');
  if (plano?.tipo !== 'botoes') return;
  assert.deepEqual(plano.botoes.map((b) => b.titulo), ['Cotação de seguro', 'Falar com atendente']);
  assert.ok(plano.corpo.includes('Como posso te ajudar hoje?'));
  assert.ok(!plano.corpo.includes('1️⃣'), 'as linhas numeradas saem do corpo');
  assert.ok(plano.corpo.includes('corretor digital'), 'a apresentação continua no corpo');
  for (const b of plano.botoes) assert.ok(b.titulo.length <= LIMITES.tituloBotao, `título longo: ${b.titulo}`);
});

test('menu de 4 ramos vira LISTA (mais de 3 opções); de 2 ramos vira botões', () => {
  const lista = planejarInterativo(buildBranchQuestion(['auto', 'moto', 'caminhao', 'residencial']));
  assert.equal(lista?.tipo, 'lista');
  if (lista?.tipo === 'lista') {
    assert.deepEqual(lista.secoes[0].itens.map((i) => i.titulo), ['Seguro de Carro', 'Seguro de Moto', 'Seguro de Caminhão', 'Seguro Residencial']);
    assert.equal(lista.corpo, 'Para qual seguro você quer a cotação?');
  }
  const botoes = planejarInterativo(buildBranchQuestion(['auto', 'moto']));
  assert.equal(botoes?.tipo, 'botoes');
});

test('pergunta de sim/não no fim da fala vira botões Sim/Não — mesmo depois do "Anotei"', () => {
  const fala = `Anotei: apartamento.\n\n${STEP_PROMPT.res_condominium}`;
  const plano = planejarInterativo(fala);
  assert.equal(plano?.tipo, 'botoes');
  if (plano?.tipo === 'botoes') {
    assert.deepEqual(plano.botoes.map((b) => b.titulo), ['Sim', 'Não']);
    assert.equal(plano.corpo, fala, 'o corpo é a fala inteira — a pergunta explica as opções');
  }
});

test('pergunta com wording de moto também é reconhecida', () => {
  const fala = STEP_PROMPT.work_commute.replace('o carro', 'a moto');
  assert.equal(planejarInterativo(fala)?.tipo, 'botoes');
});

test('estado civil (4 opções) vira lista; "Posso calcular?" vira Pode/Não', () => {
  assert.equal(planejarInterativo(STEP_PROMPT.marital_status)?.tipo, 'lista');
  const calc = planejarInterativo(STEP_PROMPT.quote_link);
  assert.equal(calc?.tipo, 'botoes');
  if (calc?.tipo === 'botoes') assert.deepEqual(calc.botoes.map((b) => b.titulo), ['Pode', 'Não']);
});

test('resultado da cotação vira botão-link e o corpo perde só a linha da URL', () => {
  const texto = 'Cotação pronta ✅\n\n1) Zurich Auto — R$ 3.525,46\n\nDetalhes completos: https://rcdemo.robocote.com.br/quote-room/abc?ramo=auto\n\n_Simulação sujeita a confirmação._';
  const plano = planejarInterativo(texto);
  assert.equal(plano?.tipo, 'link');
  if (plano?.tipo === 'link') {
    assert.equal(plano.url, 'https://rcdemo.robocote.com.br/quote-room/abc?ramo=auto');
    assert.ok(plano.corpo.includes('Zurich Auto'));
    assert.ok(plano.corpo.includes('Simulação sujeita'), 'o disclaimer fica');
    assert.ok(!plano.corpo.includes('Detalhes completos'));
    assert.ok(plano.rotulo.length <= LIMITES.rotuloLink);
  }
});

test('fala comum (pergunta aberta, "Anotei", CEP) segue como texto', () => {
  assert.equal(planejarInterativo(STEP_PROMPT.name), null);
  assert.equal(planejarInterativo(STEP_PROMPT.res_zip), null);
  assert.equal(planejarInterativo('Anotei: Jera Souto.'), null);
  assert.equal(planejarInterativo(''), null);
});

test('a triagem em texto ainda diz "atendente" — o parser do intake continua entendendo', () => {
  assert.match(SERVICE_TYPE_QUESTION, /atendente/);
});

// ─── o toque volta como fala ─────────────────────────────────────────────────

test('toque em botão chega como texto = título (e não como mídia)', () => {
  const [m] = parseCloudApiInboundMessages({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '1271003609430710' },
      messages: [{ from: '554888326647', id: 'wamid.BTN', timestamp: '1756512000', type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'opt_2', title: 'Seguro de Moto' } } }],
    } }] }],
  });
  assert.ok(m);
  assert.equal(m.text, 'Seguro de Moto');
  assert.equal(m.interactiveId, 'opt_2');
  assert.equal(m.unsupportedType, undefined, 'não é mídia');
});

test('item de lista tocado idem', () => {
  const [m] = parseCloudApiInboundMessages({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '1271003609430710' },
      messages: [{ from: '554888326647', id: 'wamid.LST', timestamp: '1756512000', type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'married', title: 'Casado(a)', description: '' } } }],
    } }] }],
  });
  assert.equal(m?.text, 'Casado(a)');
  assert.equal(m?.interactiveId, 'married');
});

// ─── envio pelo gateway ──────────────────────────────────────────────────────

const fetchOriginal = globalThis.fetch;
let chamadas: Array<{ url: string; body: Record<string, unknown> | null }> = [];

function fingir(rotas: Record<string, { status: number; json: unknown }>) {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    const chave = Object.keys(rotas).find((k) => u.endsWith(k)) ?? '';
    const r = rotas[chave] ?? { status: 404, json: { message: 'rota nao dublada' } };
    chamadas.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.json), json: async () => r.json };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  chamadas = [];
  _limparCapacidade();
  process.env.ROBOCOTE_GATEWAY_URL = 'https://gateway.exemplo';
  process.env.ROBOCOTE_GATEWAY_API_KEY = 'chave';
  delete process.env.ROBOCOTE_GATEWAY_INTERATIVO;
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  delete process.env.ROBOCOTE_GATEWAY_URL;
  delete process.env.ROBOCOTE_GATEWAY_API_KEY;
  delete process.env.ROBOCOTE_GATEWAY_INTERATIVO;
});

test('capacidade: pergunta ao gateway uma vez e lembra; falha = "não sabe"', async () => {
  fingir({ '/capacidades': { status: 200, json: { texto: true, interativo: true } } });
  assert.equal(await hasInteractive(), true);
  assert.equal(await hasInteractive(), true);
  assert.equal(chamadas.length, 1, 'segunda vez veio do cache');

  _limparCapacidade();
  fingir({ '/capacidades': { status: 500, json: {} } });
  assert.equal(await hasInteractive(), false);
});

test('ROBOCOTE_GATEWAY_INTERATIVO=off desliga sem perguntar', async () => {
  process.env.ROBOCOTE_GATEWAY_INTERATIVO = 'off';
  fingir({});
  assert.equal(await hasInteractive(), false);
  assert.equal(chamadas.length, 0);
});

test('envio interativo manda { para, interativo } e devolve o wamid', async () => {
  fingir({ '/mensagens': { status: 200, json: { enviada: true, meta_message_id: 'wamid.X' } } });
  const r = await sendWhatsappInteractive('5548988326647', { tipo: 'botoes', corpo: 'Oi?', botoes: [{ id: 'a', titulo: 'A' }] });
  assert.equal(r.ok, true);
  assert.equal(r.messageId, 'wamid.X');
  assert.equal(chamadas[0].body?.para, '5548988326647');
  assert.deepEqual((chamadas[0].body?.interativo as { tipo: string }).tipo, 'botoes');
  assert.equal(chamadas[0].body?.texto, undefined, 'XOR: interativo sem texto');
});

test('gateway recusa (400 de validação): o erro volta legível para o transporte cair no texto', async () => {
  fingir({ '/mensagens': { status: 400, json: { message: 'botão 1: título: 27 caracteres, máximo 20' } } });
  const r = await sendWhatsappInteractive('5548988326647', { tipo: 'botoes', corpo: 'Oi?', botoes: [{ id: 'a', titulo: 'x'.repeat(27) }] });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /máximo 20/);
});
