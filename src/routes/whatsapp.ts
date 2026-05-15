import { Hono } from 'hono';
import {
  parseInboundMessage,
  validateWebhookSecret,
  getEvolutionConfig,
  type EvolutionWebhookPayload,
} from '../channels/whatsapp/evolution.js';
import { processWhatsappTurn } from '../channels/whatsapp/orchestrator.js';

export const whatsapp = new Hono();

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
