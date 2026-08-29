/**
 * Guardas do orquestrador — os comportamentos mais frágeis para a extração (Fase 3).
 * São os que quebram SEM erro: o lead só recebe a coisa errada.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';
import { inbound, phone, agoMs } from '../_harness/fixtures.js';

const ctrl = createCtrl();
installMocks(ctrl);

const { processWhatsappTurn } = await import('../../src/channels/whatsapp/orchestrator.js');
const { sessionStore, createInitialSessionState } = await import('../../src/session/store.js');

function chave(p: string) {
  return { tenantId: 'test', channel: 'whatsapp' as const, channelUserId: p };
}

// ─── Proposta pendente: a IA propõe com base em pista anterior, o lead decide ────

test('proposta pendente confirmada pelo lead é aplicada e avança', async () => {
  const p = phone(150);
  await sessionStore.upsert({
    ...createInitialSessionState(chave(p)),
    stepId: 'usage',
    pendingProposal: { stepId: 'usage', value: 'work', displayLabel: 'Trabalho' },
  });

  const r = await processWhatsappTurn(inbound('sim', { fromPhone: p }));

  assert.equal(r.action, 'answer_step');
  assert.match(r.replySent ?? '', /Anotei: Trabalho/);
  assert.equal(r.sessionAfter?.answers?.usage?.value, 'Trabalho');
  assert.equal(r.sessionAfter?.pendingProposal, null, 'a proposta precisa ser limpa');
});

test('proposta pendente negada é descartada e o passo é refeito', async () => {
  const p = phone(151);
  await sessionStore.upsert({
    ...createInitialSessionState(chave(p)),
    stepId: 'usage',
    pendingProposal: { stepId: 'usage', value: 'work', displayLabel: 'Trabalho' },
  });

  const r = await processWhatsappTurn(inbound('não', { fromPhone: p }));

  assert.equal(r.action, 'ask_clarification');
  assert.match(r.replySent ?? '', /refazer/i);
  assert.equal(r.sessionAfter?.answers?.usage, undefined, 'nada pode ser gravado ao negar');
  assert.equal(r.sessionAfter?.pendingProposal, null);
});

test('mensagem ambígua limpa a proposta pendente e segue o fluxo normal', async () => {
  const p = phone(152);
  await sessionStore.upsert({
    ...createInitialSessionState(chave(p)),
    stepId: 'usage',
    pendingProposal: { stepId: 'usage', value: 'work', displayLabel: 'Trabalho' },
  });

  const r = await processWhatsappTurn(inbound('e quanto custa o seguro?', { fromPhone: p }));

  assert.equal(r.sessionAfter?.pendingProposal, null, 'proposta ambígua não pode ficar presa');
  assert.equal(r.sessionAfter?.answers?.usage, undefined, 'ambíguo não confirma nada');
});

// ─── Idempotência: cotação repetida em 60s reenvia o link, não recalcula ────────

test('cotação repetida dentro de 60s reenvia o link sem recalcular', async () => {
  const p = phone(153);
  await sessionStore.upsert({
    ...createInitialSessionState(chave(p)),
    stepId: 'quote_link',
    lastGuid: 'GUID-JA-CALCULADO',
    lastCalculateAt: Date.now() - 5_000,
  });
  ctrl.quotePayload = null;

  const r = await processWhatsappTurn(inbound('pode calcular', { fromPhone: p }));

  assert.equal(r.action, 'none', 'não dispara nova cotação');
  assert.match(r.replySent ?? '', /GUID-JA-CALCULADO/);
  assert.equal(ctrl.quotePayload, null, 'a jornada de cotação NÃO pode ser chamada de novo');
});

test('passados os 60s, a mesma confirmação recalcula de verdade', async () => {
  const p = phone(154);
  await sessionStore.upsert({
    ...createInitialSessionState(chave(p)),
    stepId: 'quote_link',
    lastGuid: 'GUID-ANTIGO',
    lastCalculateAt: Date.now() - 90_000,
  });
  ctrl.quoteMode = 'ok';
  ctrl.quotePayload = null;

  const r = await processWhatsappTurn(inbound('pode calcular', { fromPhone: p }));

  assert.equal(r.action, 'calculate');
  assert.notEqual(ctrl.quotePayload, null, 'fora da janela, recalcula');
});

// ─── Override humano: expira em 24h e o bot retoma com recapitulação ───────────

test('override vencido (24h+) devolve a conversa ao bot com recapitulação', async () => {
  const p = phone(155);
  await sessionStore.upsert({
    ...createInitialSessionState(chave(p)),
    stepId: 'name',
    humanOverride: {
      active: true,
      startedAt: agoMs(30),
      lastActivityAt: agoMs(30),
      source: 'lead_requested',
    },
  });
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound('oi, voltei', { fromPhone: p }));

  assert.notEqual(r.action, 'human_paused', 'passadas 24h o bot precisa retomar');
  assert.ok(r.replySent, 'a retomada precisa falar com o lead');
  assert.notEqual(r.sessionAfter?.humanOverride?.active, true, 'override tem que ser desativado');
});

test('override ainda dentro das 24h mantém o bot calado', async () => {
  const p = phone(156);
  await sessionStore.upsert({
    ...createInitialSessionState(chave(p)),
    stepId: 'name',
    humanOverride: {
      active: true,
      startedAt: agoMs(2),
      lastActivityAt: agoMs(2),
      source: 'lead_requested',
    },
  });
  ctrl.sent.length = 0;

  const r = await processWhatsappTurn(inbound('alguém?', { fromPhone: p }));

  assert.equal(r.action, 'human_paused');
  assert.equal(r.replySent, null);
  assert.equal(ctrl.sent.length, 0);
});

// ─── Pós-cotação ───────────────────────────────────────────────────────────────

test('lead que já cotou recebe resposta gentil e o convite para recomeçar', async () => {
  const p = phone(157);
  await sessionStore.upsert({
    ...createInitialSessionState(chave(p)),
    stepId: 'complete',
    completed: true,
    lastGuid: 'GUID-FEITO',
  });

  const r = await processWhatsappTurn(inbound('e aí, chegou?', { fromPhone: p }));

  assert.equal(r.action, 'none');
  assert.match(r.replySent ?? '', /nova cota[çc][ãa]o/i);
});

test('"nova cotação" após concluída reinicia a jornada', async () => {
  const p = phone(158);
  await sessionStore.upsert({
    ...createInitialSessionState(chave(p)),
    stepId: 'complete',
    completed: true,
    lastGuid: 'GUID-FEITO',
  });

  const r = await processWhatsappTurn(inbound('quero fazer uma nova cotação', { fromPhone: p }));

  assert.equal(r.action, 'reset');
  assert.equal(r.sessionAfter?.completed, false);
  assert.equal(r.sessionAfter?.stepId, 'service_type');
});
