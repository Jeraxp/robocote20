/**
 * Cliente HTTP da Evolution API (self-hosted).
 *
 * Compatível com Evolution API v2+. Envia mensagem de texto via instância configurada,
 * usando header `apikey` pra autenticar. Tipos do webhook inbound também estão aqui
 * pra centralizar o contrato.
 *
 * Configuração via env:
 * - EVOLUTION_BASE_URL: ex. https://rcevolution.robocote.com.br
 * - EVOLUTION_API_KEY: chave global da instância Evolution
 * - EVOLUTION_INSTANCE: nome da instância Robocote dentro do Evolution
 * - EVOLUTION_WEBHOOK_SECRET (opcional): se setado, valida header `x-webhook-secret` no webhook
 */

const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL?.trim() ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY?.trim() ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE?.trim() ?? '';
const EVOLUTION_WEBHOOK_SECRET = process.env.EVOLUTION_WEBHOOK_SECRET?.trim() ?? '';

export interface EvolutionInboundMessage {
  /** Telefone do remetente, formato E.164 sem o "+". Ex: "5511999998888" */
  fromPhone: string;
  /** Texto da mensagem (transcrito se for áudio, vazio se for mídia não suportada). */
  text: string;
  /** Indica se a mensagem veio do próprio número da Robocote (ignorar). */
  fromSelf: boolean;
  /** Nome do contato no WhatsApp, se disponível. */
  pushName?: string;
  /** ID original da mensagem no Evolution — útil pra rastreio. */
  messageId?: string;
  /** Timestamp ISO. */
  timestamp: string;
}

export interface EvolutionWebhookPayload {
  event?: string;
  instance?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function isEvolutionConfigured(): boolean {
  return Boolean(EVOLUTION_BASE_URL && EVOLUTION_API_KEY && EVOLUTION_INSTANCE);
}

export function getEvolutionConfig(): {
  configured: boolean;
  baseUrl: string;
  instance: string;
  webhookSecretConfigured: boolean;
} {
  return {
    configured: isEvolutionConfigured(),
    baseUrl: EVOLUTION_BASE_URL,
    instance: EVOLUTION_INSTANCE,
    webhookSecretConfigured: Boolean(EVOLUTION_WEBHOOK_SECRET),
  };
}

export function validateWebhookSecret(headerValue: string | null | undefined): boolean {
  if (!EVOLUTION_WEBHOOK_SECRET) return true; // sem secret configurado = sem validação
  return headerValue === EVOLUTION_WEBHOOK_SECRET;
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

function extractFromJid(jid: string): { phone: string; isGroup: boolean } {
  // JIDs no Evolution: "5511999998888@s.whatsapp.net" (DM) ou "12345@g.us" (grupo)
  const isGroup = jid.includes('@g.us');
  const phone = normalizePhone(jid.split('@')[0] ?? '');
  return { phone, isGroup };
}

/**
 * Extrai mensagem inbound de um payload de webhook do Evolution.
 * Retorna null se o evento não é uma mensagem de texto utilizável.
 *
 * Formato esperado (Evolution v2):
 * { event: 'messages.upsert', instance, data: { key: {remoteJid, fromMe, id}, message: { conversation } | { extendedTextMessage: { text } }, pushName, messageTimestamp } }
 */
export function parseInboundMessage(payload: EvolutionWebhookPayload): EvolutionInboundMessage | null {
  if (payload.event !== 'messages.upsert' && payload.event !== 'MESSAGES_UPSERT') return null;

  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return null;

  // O `data` pode ser objeto único ou array — Evolution varia entre instâncias.
  const events = Array.isArray(data) ? data : [data];
  const event = events[0] as Record<string, unknown> | undefined;
  if (!event) return null;

  const key = event.key as Record<string, unknown> | undefined;
  if (!key) return null;
  const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : '';
  if (!remoteJid) return null;

  const { phone, isGroup } = extractFromJid(remoteJid);
  if (isGroup) return null; // não atende grupos
  if (!phone) return null;

  const fromSelf = key.fromMe === true;

  const message = event.message as Record<string, unknown> | undefined;
  let text = '';
  if (message) {
    if (typeof message.conversation === 'string') {
      text = message.conversation;
    } else if (message.extendedTextMessage && typeof message.extendedTextMessage === 'object') {
      const extended = message.extendedTextMessage as Record<string, unknown>;
      if (typeof extended.text === 'string') text = extended.text;
    }
  }
  if (!text.trim()) return null;

  const timestamp = (() => {
    const ts = event.messageTimestamp;
    if (typeof ts === 'number') return new Date(ts * 1000).toISOString();
    if (typeof ts === 'string') {
      const parsed = Number(ts);
      if (Number.isFinite(parsed)) return new Date(parsed * 1000).toISOString();
    }
    return new Date().toISOString();
  })();

  return {
    fromPhone: phone,
    text: text.trim(),
    fromSelf,
    pushName: typeof event.pushName === 'string' ? event.pushName : undefined,
    messageId: typeof key.id === 'string' ? key.id : undefined,
    timestamp,
  };
}

function sendTextUrl(): string {
  return new URL(`/message/sendText/${encodeURIComponent(EVOLUTION_INSTANCE)}`, EVOLUTION_BASE_URL).toString();
}

export interface SendTextResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

/**
 * Envia mensagem de texto pra um número via Evolution API.
 * Splits longos (> 4096 chars) não tratados aqui — quem chama deve respeitar limite de canal.
 */
export async function sendWhatsappText(toPhone: string, text: string): Promise<SendTextResult> {
  if (!isEvolutionConfigured()) {
    return { ok: false, status: 0, error: 'evolution_not_configured' };
  }

  const phone = normalizePhone(toPhone);
  if (!phone) {
    return { ok: false, status: 0, error: 'invalid_phone' };
  }
  if (!text.trim()) {
    return { ok: false, status: 0, error: 'empty_text' };
  }

  try {
    const response = await fetch(sendTextUrl(), {
      method: 'POST',
      headers: {
        apikey: EVOLUTION_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: phone,
        text,
      }),
    });

    const raw = await response.text();
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* deixa string */ }

    if (!response.ok) {
      return { ok: false, status: response.status, body, error: `evolution_http_${response.status}` };
    }
    return { ok: true, status: response.status, body };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
