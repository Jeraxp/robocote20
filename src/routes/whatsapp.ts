import { Hono } from 'hono';
import {
  parseInboundMessage,
  validateWebhookSecret,
  getEvolutionConfig,
  type EvolutionWebhookPayload,
} from '../channels/whatsapp/evolution.js';
import {
  parseCloudApiInboundMessages,
  verifyCloudApiSignature,
  handleWebhookVerification,
  getCloudApiConfig,
  type CloudApiWebhookPayload,
} from '../channels/whatsapp/cloudapi.js';
import { getActiveWhatsappChannel } from '../channels/whatsapp/transport.js';
import { processWhatsappTurn } from '../channels/whatsapp/orchestrator.js';

export const whatsapp = new Hono();

whatsapp.get('/cloudapi/health', (c) => {
  const cfg = getCloudApiConfig();
  return c.json({
    ok: true,
    activeChannel: getActiveWhatsappChannel(),
    configured: cfg.configured,
    phoneNumberId: cfg.phoneNumberId || null,
    graphVersion: cfg.graphVersion,
    verifyTokenConfigured: cfg.verifyTokenConfigured,
    appSecretConfigured: cfg.appSecretConfigured,
  });
});

/**
 * Handshake de verificação do webhook (a Meta chama via GET ao cadastrar a URL).
 * URL a cadastrar no painel: https://<host>/webhooks/cloudapi/webhook
 */
whatsapp.get('/cloudapi/webhook', (c) => {
  const challenge = handleWebhookVerification(
    c.req.query('hub.mode'),
    c.req.query('hub.verify_token'),
    c.req.query('hub.challenge'),
  );
  if (challenge === null) {
    return c.json({ ok: false, error: 'verification_failed' }, 403);
  }
  return c.text(challenge, 200);
});

/**
 * Webhook inbound da Cloud API (Meta).
 *
 * Comportamento:
 *  - Valida assinatura HMAC do corpo CRU (X-Hub-Signature-256) quando APP_SECRET configurado.
 *  - Sempre responde 200 rápido — a Meta faz retry agressivo em erro e pode desativar o webhook.
 *  - Um POST pode trazer várias mensagens: cada uma vira um turno independente, fire-and-forget.
 *  - Eventos de status (sent/delivered/read) são ack sem processamento.
 */
whatsapp.post('/cloudapi/webhook', async (c) => {
  const rawBody = await c.req.text();

  if (!verifyCloudApiSignature(rawBody, c.req.header('x-hub-signature-256'))) {
    return c.json({ ok: false, error: 'invalid_signature' }, 401);
  }

  let payload: CloudApiWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as CloudApiWebhookPayload;
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400);
  }

  const inboundMessages = parseCloudApiInboundMessages(payload);
  for (const inbound of inboundMessages) {
    void processWhatsappTurn(inbound).catch((e: unknown) => {
      console.warn(`Falha ao processar turno WhatsApp (cloudapi) de ${inbound.fromPhone}: ${(e as Error).message}`);
    });
  }

  return c.json({ ok: true, accepted: inboundMessages.length });
});

whatsapp.get('/evolution/health', (c) => {
  const cfg = getEvolutionConfig();
  return c.json({
    ok: true,
    configured: cfg.configured,
    baseUrl: cfg.baseUrl || null,
    instance: cfg.instance || null,
    webhookSecretConfigured: cfg.webhookSecretConfigured,
  });
});

/**
 * Webhook inbound da Evolution API.
 * A Evolution chama esse endpoint quando uma mensagem nova chega na instância configurada.
 *
 * Comportamento:
 *  - Valida secret (se EVOLUTION_WEBHOOK_SECRET estiver setado).
 *  - Sempre responde 200 rápido (Evolution não gosta de retry em 5xx).
 *  - O processamento real roda em background com `c.executionCtx().waitUntil` quando disponível;
 *    caso contrário, dispara fire-and-forget.
 */
whatsapp.post('/evolution/incoming', async (c) => {
  const secretHeader = c.req.header('x-webhook-secret') ?? c.req.header('X-Webhook-Secret');
  if (!validateWebhookSecret(secretHeader)) {
    return c.json({ ok: false, error: 'invalid_webhook_secret' }, 401);
  }

  let payload: EvolutionWebhookPayload;
  try {
    payload = await c.req.json<EvolutionWebhookPayload>();
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400);
  }

  const inbound = parseInboundMessage(payload);
  if (!inbound) {
    // Eventos não-mensagem (status, qr, etc) — apenas ack.
    return c.json({ ok: true, ignored: true });
  }

  // Fire-and-forget: Evolution recebe ACK na mesma hora, processamento corre por trás.
  // Erros vão pra console.warn — não propagamos pro Evolution.
  void processWhatsappTurn(inbound).catch((e: unknown) => {
    console.warn(`Falha ao processar turno WhatsApp de ${inbound.fromPhone}: ${(e as Error).message}`);
  });

  return c.json({ ok: true, accepted: true });
});
