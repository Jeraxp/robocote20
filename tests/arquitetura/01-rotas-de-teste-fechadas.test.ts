/**
 * Rotas de teste não sobem abertas na internet.
 *
 * Sem login, o console `/test` consulta pessoa por CPF na Segfy (nome,
 * nascimento, e-mail e celular) e dispara cotação real com a credencial da
 * corretora; `/api/jornadas/auto/f1/cotacao` e `/api/assistente/*` gastam
 * cotação e IA sem dono. Elas só existem com `ROBOCOTE_ROTAS_DE_TESTE=1`
 * (desenvolvimento local). Sem a variável, respondem 404, como rota que não
 * existe.
 */

import './../_harness/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { test as consoleDeTeste } from '../../src/routes/test.js';
import { api } from '../../src/routes/api.js';

const ROTAS_AVULSAS_DA_API = [
  '/jornadas/auto/f1/cotacao',
  '/assistente/auto/f1/mensagem',
  '/assistente/rag/search',
];

async function postVazio(caminho: string): Promise<Response> {
  return api.request(caminho, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });
}

let anterior: string | undefined;

beforeEach(() => {
  anterior = process.env.ROBOCOTE_ROTAS_DE_TESTE;
  delete process.env.ROBOCOTE_ROTAS_DE_TESTE;
});

afterEach(() => {
  if (anterior === undefined) delete process.env.ROBOCOTE_ROTAS_DE_TESTE;
  else process.env.ROBOCOTE_ROTAS_DE_TESTE = anterior;
});

test('sem a variável, o console /test responde 404, inclusive a consulta por CPF', async () => {
  for (const caminho of ['/condutor/12345678909', '/auth']) {
    const res = await consoleDeTeste.request(caminho);
    assert.equal(res.status, 404, `GET /test${caminho}`);
  }
});

test('sem a variável, cotação e assistente avulsos da API respondem 404', async () => {
  for (const caminho of ROTAS_AVULSAS_DA_API) {
    const res = await postVazio(caminho);
    assert.equal(res.status, 404, `POST /api${caminho}`);
  }
});

test('com ROBOCOTE_ROTAS_DE_TESTE=1, as rotas avulsas voltam a responder', async () => {
  process.env.ROBOCOTE_ROTAS_DE_TESTE = '1';
  for (const caminho of ROTAS_AVULSAS_DA_API) {
    const res = await postVazio(caminho);
    assert.notEqual(res.status, 404, `POST /api${caminho}`);
  }
});
