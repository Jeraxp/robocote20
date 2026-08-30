/**
 * O ENVIO pelo gateway oficial (contrato v2). O motor não fala com a Meta —
 * fala com o gateway, que é o carteiro. Estes testes travam o formato acordado:
 * URL, header da chave, corpo {para, texto}, e o que fazer quando dá errado.
 */

import './../_harness/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendWhatsappText, splitForWhatsapp, isGatewayConfigured } from '../../src/channels/whatsapp/gateway.js';

const fetchOriginal = globalThis.fetch;
let chamadas: Array<{ url: string; headers: Record<string, string>; body: Record<string, string> }> = [];

function fingirGateway(resposta: { status: number; json?: unknown }) {
  globalThis.fetch = (async (url: unknown, init: { headers?: unknown; body?: unknown }) => {
    chamadas.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, string>,
    });
    const corpo = JSON.stringify(resposta.json ?? {});
    return {
      ok: resposta.status >= 200 && resposta.status < 300,
      status: resposta.status,
      text: async () => corpo,
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  chamadas = [];
  process.env.ROBOCOTE_GATEWAY_URL = 'https://gateway.exemplo/';
  process.env.ROBOCOTE_GATEWAY_API_KEY = 'chave-do-motor';
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  delete process.env.ROBOCOTE_GATEWAY_URL;
  delete process.env.ROBOCOTE_GATEWAY_API_KEY;
});

test('envia no formato do contrato: URL, header da chave e corpo {para, texto}', async () => {
  fingirGateway({ status: 200, json: { enviada: true, meta_message_id: 'wamid.ABC' } });
  const r = await sendWhatsappText('+55 (48) 98832-6647', 'Ola! Eu sou o Robocote.');

  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, 'https://gateway.exemplo/api/v1/robocote/mensagens');
  assert.equal(chamadas[0].headers['x-motor-api-key'], 'chave-do-motor');
  assert.equal(chamadas[0].body.para, '5548988326647', 'telefone vai so com digitos');
  assert.equal(chamadas[0].body.texto, 'Ola! Eu sou o Robocote.');
  assert.equal(r.ok, true);
  assert.equal(r.messageId, 'wamid.ABC', 'o wamid e a unica prova de que a Meta aceitou');
});

test('chave errada (401) nao e sucesso disfarcado', async () => {
  fingirGateway({ status: 401, json: { message: 'chave invalida' } });
  const r = await sendWhatsappText('5548988326647', 'oi');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.error, 'chave invalida');
});

test('tenant nao configurado no gateway (503) chega legivel', async () => {
  fingirGateway({ status: 503, json: { message: 'tenant nao configurado' } });
  const r = await sendWhatsappText('5548988326647', 'oi');
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('resposta com enviada=false NAO conta como enviado', async () => {
  fingirGateway({ status: 200, json: { enviada: false } });
  const r = await sendWhatsappText('5548988326647', 'oi');
  assert.equal(r.ok, false, 'HTTP 200 com enviada=false e falha, nao sucesso');
});

test('sem configuracao, recusa em vez de tentar a rede', async () => {
  delete process.env.ROBOCOTE_GATEWAY_URL;
  assert.equal(isGatewayConfigured(), false);
  const r = await sendWhatsappText('5548988326647', 'oi');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'gateway_nao_configurado');
  assert.equal(chamadas.length, 0, 'nao chama a rede sem saber para onde');
});

test('texto vazio e destino invalido sao barrados antes da rede', async () => {
  fingirGateway({ status: 200, json: { enviada: true } });
  assert.equal((await sendWhatsappText('5548988326647', '   ')).ok, false);
  assert.equal((await sendWhatsappText('sem-digitos', 'oi')).ok, false);
  assert.equal(chamadas.length, 0);
});

test('cotacao longa vira VARIAS mensagens em vez de erro 400', async () => {
  fingirGateway({ status: 200, json: { enviada: true, meta_message_id: 'wamid.X' } });
  const paragrafo = 'Seguradora Exemplo - cobertura completa, franquia reduzida.\n\n';
  const longo = paragrafo.repeat(200); // ~11k chars, muito acima do teto de 4096
  const r = await sendWhatsappText('5548988326647', longo);

  assert.equal(r.ok, true);
  assert.ok(chamadas.length > 1, `esperava varios envios, houve ${chamadas.length}`);
  for (const c of chamadas) {
    assert.ok(c.body.texto.length <= 4000, `pedaco de ${c.body.texto.length} estourou o teto`);
  }
});

test('se um pedaco falha, para ali - fim sem comeco confunde mais que silencio', async () => {
  let n = 0;
  globalThis.fetch = (async (url: unknown, init: { headers?: unknown; body?: unknown }) => {
    n++;
    chamadas.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, string>,
    });
    const falha = n === 2;
    return {
      ok: !falha,
      status: falha ? 400 : 200,
      text: async () => JSON.stringify(falha ? { message: 'erro no meio' } : { enviada: true }),
    };
  }) as unknown as typeof fetch;

  const r = await sendWhatsappText('5548988326647', 'x'.repeat(9000));
  assert.equal(r.ok, false);
  assert.equal(chamadas.length, 2, 'parou no pedaco que falhou, nao seguiu mandando');
});

test('quebra em fronteira natural, sem partir palavra no meio', () => {
  const texto = 'palavra '.repeat(1000).trim();
  const partes = splitForWhatsapp(texto, 100);
  assert.ok(partes.length > 1);
  for (const p of partes) {
    assert.ok(p.length <= 100);
    assert.ok(!p.startsWith(' ') && !p.endsWith(' '));
  }
  assert.equal(partes.join(' ').replace(/\s+/g, ' '), texto, 'nada se perde na quebra');
});

test('texto curto passa inteiro, sem quebra', () => {
  assert.deepEqual(splitForWhatsapp('mensagem curta'), ['mensagem curta']);
});
