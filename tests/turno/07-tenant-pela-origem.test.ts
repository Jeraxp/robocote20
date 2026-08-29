/**
 * FASE 2 — a corretora é identificada pela ORIGEM da mensagem.
 *
 * Sem isto, todo lead cai num tenant padrão de variável de ambiente: com duas
 * corretoras no ar, lead de uma aparece no painel da outra. É o bloqueio
 * comercial para vender o segundo cliente.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';
import { inbound, phone } from '../_harness/fixtures.js';

const ctrl = createCtrl();
ctrl.aiAutoAccept = true;
// Mapa origem -> corretora, como estará no banco (whatsapp_instances).
ctrl.contasWhatsapp = {
  'robocote-renova': 'renova',
  'robocote-vida-e-saude': 'vida-e-saude',
  '5548999990001': 'renova',
};
installMocks(ctrl);

const { processWhatsappTurn } = await import('../../src/channels/whatsapp/orchestrator.js');

test('mensagem que chega pela conta da Renova nasce no tenant da Renova', async () => {
  const r = await processWhatsappTurn(
    inbound('oi', { fromPhone: phone(170), channelAccountId: 'robocote-renova' }),
  );

  assert.equal(r.sessionAfter?.tenantId, 'renova');
});

test('MESMO telefone em contas diferentes gera sessões separadas (sem vazamento)', async () => {
  const p = phone(171);

  const a = await processWhatsappTurn(
    inbound('oi', { fromPhone: p, channelAccountId: 'robocote-renova' }),
  );
  const b = await processWhatsappTurn(
    inbound('oi', { fromPhone: p, channelAccountId: 'robocote-vida-e-saude' }),
  );

  assert.equal(a.sessionAfter?.tenantId, 'renova');
  assert.equal(b.sessionAfter?.tenantId, 'vida-e-saude');
  assert.notEqual(
    a.sessionAfter?.tenantId,
    b.sessionAfter?.tenantId,
    'o mesmo lead falando com duas corretoras não pode virar uma sessão só',
  );
});

test('número da Cloud API também resolve a corretora', async () => {
  const r = await processWhatsappTurn(
    inbound('oi', { fromPhone: phone(172), channelAccountId: '5548999990001' }),
  );

  assert.equal(r.sessionAfter?.tenantId, 'renova');
});

test('tenantId explícito vence a resolução pela origem', async () => {
  const r = await processWhatsappTurn(
    inbound('oi', { fromPhone: phone(173), channelAccountId: 'robocote-renova' }),
    { tenantId: 'unidas' },
  );

  assert.equal(r.sessionAfter?.tenantId, 'unidas', 'chamada interna manda mais que o webhook');
});

test('DETECTOR: origem desconhecida não é adivinhada em silêncio', async () => {
  const r = await processWhatsappTurn(
    inbound('oi', { fromPhone: phone(174), channelAccountId: 'conta-nao-cadastrada' }),
  );

  assert.equal(
    r.sessionAfter?.tenantUnresolved,
    true,
    'a sessão precisa carregar a marca de que a corretora não foi identificada',
  );
});

test('mensagem sem origem (legado) continua funcionando com o tenant padrão', async () => {
  const r = await processWhatsappTurn(inbound('oi', { fromPhone: phone(175) }));

  assert.equal(r.sessionAfter?.tenantId, 'test', 'compatibilidade com quem ainda não manda origem');
});
