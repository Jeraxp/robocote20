/**
 * Questionário de risco condicional — as regras que decidem quais perguntas o
 * lead NÃO vê. É exatamente a área que a decisão das 26 perguntas vai mexer,
 * então precisa estar congelada antes.
 *
 * NOTA: a mensagem enviada É o valor canônico (yes/no/new) porque o turno grava
 * o texto como resposta do passo — mandar 'sim' sobrescreveria o dado testado.
 *
 * Exercitado pela porta pública (processWhatsappTurn), não pela função interna:
 * o que interessa congelar é o comportamento observável.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCtrl, installMocks } from '../_harness/mocks.js';
import { inbound, phone } from '../_harness/fixtures.js';

const ctrl = createCtrl();
ctrl.aiAutoAccept = true;
installMocks(ctrl);

const { processWhatsappTurn } = await import('../../src/channels/whatsapp/orchestrator.js');
const { sessionStore, createInitialSessionState } = await import('../../src/session/store.js');

type Resposta = { id: string; label: string; value: string; rawValue: string };

function resp(id: string, rawValue: string): Resposta {
  return { id, label: id, value: rawValue, rawValue };
}

/** Semeia a sessão num passo com respostas específicas e devolve o próximo passo. */
async function proximoPassoApos(
  p: string,
  stepId: string,
  answers: Record<string, Resposta>,
  texto: string,
): Promise<string | undefined> {
  await sessionStore.upsert({
    ...createInitialSessionState({ tenantId: 'test', channel: 'whatsapp', channelUserId: p }),
    stepId: stepId as never,
    answers: answers as never,
  });
  const r = await processWhatsappTurn(inbound(texto, { fromPhone: p }));
  return r.sessionAfter?.stepId;
}

test('quem é o motorista principal NÃO informa o CPF do condutor', async () => {
  const proximo = await proximoPassoApos(
    phone(160),
    'is_main_driver',
    { is_main_driver: resp('is_main_driver', 'yes') },
    'yes',
  );
  assert.notEqual(proximo, 'main_driver_document', 'o CPF do condutor tem que ser pulado');
});

test('quem NÃO é o motorista principal precisa informar o CPF do condutor', async () => {
  const proximo = await proximoPassoApos(
    phone(161),
    'is_main_driver',
    { is_main_driver: resp('is_main_driver', 'no') },
    'no',
  );
  assert.equal(proximo, 'main_driver_document', 'condutor diferente exige o CPF dele');
});

test('quem não estuda não é perguntado sobre garagem na faculdade', async () => {
  const proximo = await proximoPassoApos(
    phone(162),
    'studies',
    { studies: resp('studies', 'no') },
    'no',
  );
  assert.notEqual(proximo, 'study_garage');
});

test('quem estuda é perguntado sobre garagem na faculdade', async () => {
  const proximo = await proximoPassoApos(
    phone(163),
    'studies',
    { studies: resp('studies', 'yes') },
    'yes',
  );
  assert.equal(proximo, 'study_garage');
});

test('seguro NOVO não pergunta bônus de renovação', async () => {
  const proximo = await proximoPassoApos(
    phone(164),
    'renewal_status',
    { renewal_status: resp('renewal_status', 'new') },
    'new',
  );
  assert.notEqual(proximo, 'renewal_bonus', 'bônus só existe em renovação');
});

test('RENOVAÇÃO pergunta o bônus', async () => {
  const proximo = await proximoPassoApos(
    phone(165),
    'renewal_status',
    { renewal_status: resp('renewal_status', 'renovacao') },
    'renovacao',
  );
  assert.equal(proximo, 'renewal_bonus');
});

test('data de nascimento já obtida na consulta por CPF não é perguntada de novo', async () => {
  const proximo = await proximoPassoApos(
    phone(166),
    'studies',
    {
      studies: resp('studies', 'no'),
      driver_birth_date: resp('driver_birth_date', '1985-04-12'),
      driver_sex: resp('driver_sex', 'M'),
    },
    'no',
  );
  assert.notEqual(proximo, 'driver_birth_date', 'não repetir o que a consulta já trouxe');
  assert.notEqual(proximo, 'driver_sex');
});
