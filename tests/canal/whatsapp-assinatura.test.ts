/**
 * GUARD-RAIL do canal oficial: o webhook não aceita corpo sem assinatura válida.
 *
 * Por que este teste existe (30/08): a URL do webhook vira endereço PÚBLICO no
 * momento em que o gateway a registra. Se a validação falhar ABERTA quando o
 * segredo não está configurado, qualquer um que descubra o endereço cria
 * conversa, queima token de IA e injeta lead falso no painel — sem senha, sem
 * rastro de intrusão, porque do ponto de vista do sistema é tráfego legítimo.
 *
 * A regra é a mesma do handshake logo acima no arquivo: SEM SEGREDO, SEM ENTRADA.
 * Canal que não consegue provar quem está falando não deve aceitar ninguém.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyCloudApiSignature } from '../../src/channels/whatsapp/cloudapi.js';

const CORPO = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

function assinar(corpo: string, segredo: string): string {
  return `sha256=${createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex')}`;
}

function comSegredo<T>(segredo: string, fn: () => T): T {
  const antes = process.env.WHATSAPP_CLOUD_APP_SECRET;
  process.env.WHATSAPP_CLOUD_APP_SECRET = segredo;
  try {
    return fn();
  } finally {
    if (antes === undefined) delete process.env.WHATSAPP_CLOUD_APP_SECRET;
    else process.env.WHATSAPP_CLOUD_APP_SECRET = antes;
  }
}

test('sem App Secret configurado, RECUSA — mesmo com corpo bem formado', () => {
  comSegredo('', () => {
    assert.equal(verifyCloudApiSignature(CORPO, undefined), false);
    assert.equal(verifyCloudApiSignature(CORPO, assinar(CORPO, 'qualquer')), false);
  });
});

test('com App Secret, aceita assinatura correta', () => {
  comSegredo('segredo-do-gateway', () => {
    assert.equal(verifyCloudApiSignature(CORPO, assinar(CORPO, 'segredo-do-gateway')), true);
  });
});

test('com App Secret, recusa assinatura de outro segredo', () => {
  comSegredo('segredo-do-gateway', () => {
    assert.equal(verifyCloudApiSignature(CORPO, assinar(CORPO, 'segredo-errado')), false);
  });
});

test('recusa corpo adulterado com assinatura do corpo original', () => {
  comSegredo('segredo-do-gateway', () => {
    const assinaturaDoOriginal = assinar(CORPO, 'segredo-do-gateway');
    const adulterado = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'injetado' }] });
    assert.equal(verifyCloudApiSignature(adulterado, assinaturaDoOriginal), false);
  });
});

test('recusa cabeçalho sem o prefixo sha256= e recusa header vazio', () => {
  comSegredo('segredo-do-gateway', () => {
    const hmac = createHmac('sha256', 'segredo-do-gateway').update(CORPO, 'utf8').digest('hex');
    assert.equal(verifyCloudApiSignature(CORPO, hmac), false, 'hmac cru sem prefixo não vale');
    assert.equal(verifyCloudApiSignature(CORPO, ''), false);
    assert.equal(verifyCloudApiSignature(CORPO, null), false);
  });
});
