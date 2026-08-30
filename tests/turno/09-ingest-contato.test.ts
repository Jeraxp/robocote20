/**
 * Lead sem forma de contato não entra no painel.
 *
 * 72% do acervo do legado são conversas abertas e abandonadas sem responder
 * nada — cards com código e mais nada, inúteis pro corretor. Não é rejeição por
 * erro: é lead que ainda não existe. Quando a pessoa der telefone ou e-mail, o
 * observador re-envia e o lead nasce.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';

const ctrl = createCtrl();
installMocks(ctrl);

process.env.ROBOCOTE_INGEST_SECRET = 'seg';
const { ingest } = await import('../../src/routes/ingest.js');
const { sessionStore } = await import('../../src/session/store.js');

async function enviar(lead: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await ingest.request('/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-robocote-ingest-secret': 'seg' },
    body: JSON.stringify({ leads: [lead] }),
  });
  return await r.json() as Record<string, unknown>;
}

test('lead sem telefone e sem e-mail é IGNORADO, não criado', async () => {
  const j = await enviar({ protocolo: 'VAZIO-1', tenantId: 'test', criadoEm: '2026-08-01T10:00:00Z' });

  assert.equal(j.ignorados, 1, 'não pode virar card no painel');
  assert.equal(j.criados, 0);
  const existe = await sessionStore.get({
    tenantId: 'test', channel: 'webchat', channelUserId: 'legado:VAZIO-1',
  });
  assert.equal(existe, null, 'nada é gravado');
});

test('só o nome não basta — não dá pra contatar um nome', async () => {
  const j = await enviar({ protocolo: 'SO-NOME', tenantId: 'test', nome: 'Ana Ribeiro' });

  assert.equal(j.ignorados, 1);
  assert.equal(j.criados, 0);
});

test('com WhatsApp, entra normalmente', async () => {
  const j = await enviar({ protocolo: 'COM-FONE', tenantId: 'test', nome: 'Ana Ribeiro', whatsapp: '48999887766' });

  assert.equal(j.criados, 1);
});

test('só com e-mail também entra — dá pra escrever pra ele', async () => {
  const j = await enviar({ protocolo: 'COM-MAIL', tenantId: 'test', email: 'ana@exemplo.com.br' });

  assert.equal(j.criados, 1);
});

test('o lead nasce quando a pessoa finalmente dá o contato', async () => {
  await enviar({ protocolo: 'DEPOIS', tenantId: 'test' });                       // abandonou
  const j = await enviar({ protocolo: 'DEPOIS', tenantId: 'test', whatsapp: '48999880000' }); // voltou

  assert.equal(j.criados, 1, 'ignorar antes não pode impedir de nascer depois');
});
