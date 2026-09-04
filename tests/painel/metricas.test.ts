/**
 * Os números do topo do painel contavam a JANELA carregada (500 leads), não a
 * base — "Leads: 500" era o teto se passando por total, com o acervo do legado
 * misturado no meio. Número no painel é decisão de corretor: ou é verdade, ou
 * não deveria estar na tela.
 */

import './../_harness/env.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';

const ctrl = createCtrl();
installMocks(ctrl);

const { sessionStore, createInitialSessionState, statusDaSessao } =
  await import('../../src/session/store.js');

type Estagio = 'novos_leads' | 'contatados' | 'historico';

async function semear(n: number, tenantId: string, patch: Record<string, unknown> = {}, estagio: Estagio = 'novos_leads') {
  for (let i = 0; i < n; i++) {
    const base = createInitialSessionState({
      tenantId,
      channel: 'whatsapp',
      channelUserId: `${tenantId}-${estagio}-${JSON.stringify(patch).length}-${i}`,
    });
    await sessionStore.upsert({ ...base, pipelineStage: estagio, ...patch });
  }
}

beforeEach(async () => {
  for (const s of await sessionStore.list({ limit: 100000 })) {
    await sessionStore.delete?.({ tenantId: s.tenantId, channel: s.channel, channelUserId: s.channelUserId });
  }
});

test('a contagem é da BASE, não da janela: 600 leads não viram 500', async () => {
  await semear(600, 'grande');
  const janela = await sessionStore.list({ tenantId: 'grande', limit: 500 });
  const m = await sessionStore.metrics({ tenantId: 'grande' });
  assert.equal(janela.length, 500, 'a janela continua protegendo a memória');
  assert.equal(m.total, 600, 'mas o número na tela é o total de verdade');
});

test('o acervo do legado fica FORA do funil — e aparece à parte', async () => {
  await semear(5, 'casa');
  await semear(40, 'casa', {}, 'historico');
  const m = await sessionStore.metrics({ tenantId: 'casa' });
  assert.equal(m.total, 5, 'o Kanban mostra 5; o cartão tem que dizer 5');
  assert.equal(m.archived, 40);
});

test('cada status cai no cartão certo, com a precedência do painel', async () => {
  await semear(3, 'mix');
  await semear(2, 'mix', { stepId: 'quote_link' });
  await semear(4, 'mix', { lastGuid: 'GUID-1' });
  await semear(1, 'mix', { pendingProposal: { stepId: 'name', value: 'x' } });

  const m = await sessionStore.metrics({ tenantId: 'mix' });
  assert.equal(m.total, 10);
  assert.equal(m.active, 3);
  assert.equal(m.ready, 2);
  assert.equal(m.quoted, 4, 'quem tem cotação entregue conta como cotado');
  assert.equal(m.waiting, 1);
});

test('uma corretora não enxerga o número da outra', async () => {
  await semear(7, 'corretora-a');
  await semear(3, 'corretora-b');
  assert.equal((await sessionStore.metrics({ tenantId: 'corretora-a' })).total, 7);
  assert.equal((await sessionStore.metrics({ tenantId: 'corretora-b' })).total, 3);
  assert.equal((await sessionStore.metrics({})).total, 10, 'superadmin sem corretora soma tudo');
});

test('statusDaSessao mantém a precedência que o painel exibe', () => {
  const base = createInitialSessionState({ tenantId: 't', channel: 'webchat', channelUserId: 'wc_x' });
  assert.equal(statusDaSessao(base), 'active');
  assert.equal(statusDaSessao({ ...base, stepId: 'quote_link' }), 'ready');
  assert.equal(statusDaSessao({ ...base, pendingProposal: { stepId: 'name', value: 'x' } as never }), 'waiting');
  assert.equal(statusDaSessao({ ...base, lastGuid: 'G' }), 'quoted');
  assert.equal(
    statusDaSessao({ ...base, stepId: 'quote_link', lastGuid: 'G' }),
    'quoted',
    'cotado vence pronto-para-calcular',
  );
});
