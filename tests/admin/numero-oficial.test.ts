/**
 * Cadastro do número OFICIAL pelo painel (decisão Jera 01/09).
 * Fecha o achado "bloqueia-estreia" da auditoria de 31/08: a coluna
 * cloud_phone_number_id era só lida — cadastro só por SQL.
 * Guard-rail que importa: o mesmo número NUNCA atende duas corretoras.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAdminStore, WhatsappNumberTakenError } from '../../src/admin/store.js';

test('número oficial nasce como canal cloudapi, com o id gravado', async () => {
  const store = new InMemoryAdminStore();
  const r = await store.createWhatsappInstance({
    tenantId: 'robocote',
    evolutionInstanceName: 'cloudapi-robocote-1271003609430710',
    cloudPhoneNumberId: '1271003609430710',
    ownerPhone: '5548991559679',
    status: 'connected',
  });
  assert.equal(r.cloudPhoneNumberId, '1271003609430710');
  assert.equal(r.channel, 'cloudapi');
  assert.equal(r.status, 'connected');
});

test('o mesmo número em outra corretora é recusado — vazamento entre clientes é o pior defeito', async () => {
  const store = new InMemoryAdminStore();
  await store.createWhatsappInstance({
    tenantId: 'robocote',
    evolutionInstanceName: 'cloudapi-robocote-111',
    cloudPhoneNumberId: '111',
  });
  await assert.rejects(
    () => store.createWhatsappInstance({
      tenantId: 'rpi',
      evolutionInstanceName: 'cloudapi-rpi-111',
      cloudPhoneNumberId: '111',
    }),
    (e: unknown) => e instanceof WhatsappNumberTakenError,
  );
});

test('a mesma corretora recadastrando o próprio número atualiza o telefone — sem 409 falso', async () => {
  const store = new InMemoryAdminStore();
  const antes = await store.createWhatsappInstance({
    tenantId: 'robocote',
    evolutionInstanceName: 'wa-robocote-mostruario', // nome fora da convenção (linha nascida por SQL)
    cloudPhoneNumberId: '222',
  });
  const depois = await store.createWhatsappInstance({
    tenantId: 'robocote',
    evolutionInstanceName: 'cloudapi-robocote-222',
    cloudPhoneNumberId: '222',
    ownerPhone: '5548991559679',
    status: 'connected',
  });
  assert.equal(depois.id, antes.id, 'é a mesma linha, atualizada');
  assert.equal(depois.ownerPhone, '5548991559679');
});

test('instância legada (sem id oficial) continua sendo evolution', async () => {
  const store = new InMemoryAdminStore();
  const r = await store.createWhatsappInstance({
    tenantId: 'rpi',
    evolutionInstanceName: 'robocote-rpi-legado',
  });
  assert.equal(r.cloudPhoneNumberId, null);
  assert.equal(r.channel, 'evolution');
});
