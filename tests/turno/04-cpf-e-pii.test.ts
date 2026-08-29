/**
 * CPF e dado sensível — o arquivo de maior valor de conformidade.
 * Congela como o CPF é guardado e o que sai para fora do sistema.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';
import { inbound, phone } from '../_harness/fixtures.js';

const ctrl = createCtrl();
installMocks(ctrl);

const { processWhatsappTurn } = await import('../../src/channels/whatsapp/orchestrator.js');
const { sessionStore, createInitialSessionState } = await import('../../src/session/store.js');

/** CPF sintético válido em dígito verificador — não pertence a ninguém. */
const CPF_VALIDO = '529.982.247-25';

async function noPassoDoCpf(p: string): Promise<void> {
  const key = { tenantId: 'test', channel: 'whatsapp' as const, channelUserId: p };
  await sessionStore.upsert({
    ...createInitialSessionState(key),
    stepId: 'document',
    answers: {
      name: { id: 'name', label: 'Nome', value: 'Ana Ribeiro', rawValue: 'Ana Ribeiro' },
    },
  });
}

test('CPF é guardado MASCARADO para exibição e cru só no campo interno', async () => {
  const p = phone(140);
  await noPassoDoCpf(p);

  const r = await processWhatsappTurn(inbound(CPF_VALIDO, { fromPhone: p }));

  const doc = r.sessionAfter?.answers?.document;
  assert.ok(doc, 'o CPF precisa ser gravado no passo document');
  assert.notEqual(doc?.value, CPF_VALIDO, 'o valor de exibição não pode ser o CPF cru');
  assert.match(doc?.value ?? '', /\*/, 'o valor de exibição precisa estar mascarado');
  assert.match(doc?.rawValue ?? '', /\d{11}/, 'o valor interno guarda os dígitos para a seguradora');
});

test('CPF inválido não é gravado e o lead é convidado a corrigir', async () => {
  const p = phone(141);
  await noPassoDoCpf(p);

  const r = await processWhatsappTurn(inbound('111.111.111-11', { fromPhone: p }));

  assert.equal(r.sessionAfter?.answers?.document, undefined, 'CPF inválido não pode ser aceito');
  assert.equal(r.sessionAfter?.stepId, 'document', 'continua pedindo o CPF');
});

test('o histórico da conversa guarda a mensagem com PII mascarada', async () => {
  const p = phone(142);
  await noPassoDoCpf(p);

  const r = await processWhatsappTurn(inbound(`meu cpf é ${CPF_VALIDO}`, { fromPhone: p }));

  const textos = (r.sessionAfter?.recentMessages ?? []).join(' ');
  assert.ok(
    !textos.includes('529.982.247-25'),
    'o buffer de contexto não pode carregar CPF cru — ele vai para a IA',
  );
});

test('CARACTERIZACAO: o que o orquestrador entrega à IA no passo do CPF', async () => {
  // Congela o contrato do seam com a IA. O gate que impede o CPF de sair vive
  // DENTRO de assistant/autoF1 (mustStayLocal) — aqui registramos o que chega nele.
  const p = phone(143);
  await noPassoDoCpf(p);
  ctrl.aiCalls.length = 0;

  await processWhatsappTurn(inbound('não sei meu cpf agora', { fromPhone: p }));

  assert.ok(ctrl.aiCalls.length >= 1, 'a IA é consultada quando não há CPF na mensagem');
  const req = ctrl.aiCalls[0] as { snapshot?: { stepId?: string }; channel?: string };
  assert.equal(req.snapshot?.stepId, 'document');
  assert.equal(req.channel, 'whatsapp');
});

test('CARACTERIZACAO: no handoff humano, a mensagem entra CRUA no histórico', async () => {
  // FURO CONHECIDO, congelado de propósito: os três ramos de intervenção humana
  // (orchestrator.ts ~:453, ~:474, ~:504) gravam `inbound.text` sem máscara, ao
  // contrário do buffer de contexto. Se um lead mandar CPF enquanto o operador
  // está ativo, ele vai cru para o histórico que o painel exibe.
  // NÃO corrigir aqui — é trabalho da Fase 5 (detectores/PII). Este teste existe
  // para que a correção seja DELIBERADA e visível, não acidental.
  const p = phone(144);
  await noPassoDoCpf(p);
  await processWhatsappTurn(inbound('2', { fromPhone: p })); // pede atendente? (passo document)

  // Ativa override explicitamente via mensagem do próprio número (operador digitando).
  ctrl.isBotEcho = false;
  await processWhatsappTurn(inbound('oi, aqui é o corretor', { fromPhone: p, fromSelf: true }));

  const r = await processWhatsappTurn(inbound(`meu cpf é ${CPF_VALIDO}`, { fromPhone: p }));

  const historico = (r.sessionAfter?.interactions ?? []).map((i) => i.text).join(' ');
  assert.ok(
    historico.includes(CPF_VALIDO),
    'comportamento ATUAL: o histórico guarda o texto cru durante o override',
  );
});
