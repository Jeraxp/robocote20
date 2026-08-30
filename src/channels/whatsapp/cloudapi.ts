/**
 * Cliente da API oficial do WhatsApp (Meta Cloud API).
 *
 * Canal oficial via Graph API — Taskdun é Meta Tech Provider. Envia texto pelo
 * endpoint `/{PHONE_NUMBER_ID}/messages` e recebe mensagens pelo webhook da Meta
 * (handshake GET + eventos POST assinados com HMAC-SHA256 do App Secret).
 *
 * Diferenças de contrato vs Evolution que importam pro orquestrador:
 *  - O webhook NÃO ecoa mensagens enviadas pelo bot (só inbound de usuário + status),
 *    então não existe dedup anti-eco aqui — `fromSelf` é sempre false.
 *  - Um POST de webhook pode carregar VÁRIAS mensagens (batch) — o parse retorna array.
 *
 * Configuração via env:
 * - WHATSAPP_CLOUD_TOKEN: token de System User (permanente) com escopo whatsapp_business_messaging
 * - WHATSAPP_CLOUD_PHONE_NUMBER_ID: ID do número registrado (não é o telefone — é o ID da Graph)
 * - WHATSAPP_CLOUD_VERIFY_TOKEN: string nossa, conferida no handshake GET do webhook
 * - WHATSAPP_CLOUD_APP_SECRET: App Secret do app Meta — valida assinatura dos POSTs
 * - WHATSAPP_CLOUD_GRAPH_VERSION (opcional): default v23.0
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const CLOUD_TOKEN = process.env.WHATSAPP_CLOUD_TOKEN?.trim() ?? '';
const CLOUD_PHONE_NUMBER_ID = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID?.trim() ?? '';
const CLOUD_VERIFY_TOKEN = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN?.trim() ?? '';
const CLOUD_GRAPH_VERSION = process.env.WHATSAPP_CLOUD_GRAPH_VERSION?.trim() || 'v23.0';

/**
 * App Secret lido na HORA da chamada (não congelado no import).
 * O segredo pode chegar depois do boot — e const congelada em env é intestável.
 */
function cloudAppSecret(): string {
  return process.env.WHATSAPP_CLOUD_APP_SECRET?.trim() ?? '';
}

/** Mesmo shape do inbound da Evolution — contrato neutro consumido pelo orquestrador. */
export interface CloudApiInboundMessage {
  /** Telefone do remetente, formato E.164 sem o "+". Ex: "5511999998888" */
  fromPhone: string;
  /** Texto da mensagem (vazio se for mídia não suportada — filtrado antes). */
  text: string;
  /** Cloud API não ecoa mensagens do bot — sempre false. */
  fromSelf: boolean;
  /** Nome do contato no WhatsApp, se disponível. */
  pushName?: string;
  /** ID original da mensagem (wamid) — útil pra rastreio. */
  messageId?: string;
  /** Timestamp ISO. */
  timestamp: string;
  /** Número que RECEBEU a mensagem (`metadata.phone_number_id`) — identifica a corretora. */
  channelAccountId?: string;
}

export interface SendTextResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

export function isCloudApiConfigured(): boolean {
  return Boolean(CLOUD_TOKEN && CLOUD_PHONE_NUMBER_ID);
}

export function getCloudApiConfig(): {
  configured: boolean;
  phoneNumberId: string;
  graphVersion: string;
  verifyTokenConfigured: boolean;
  appSecretConfigured: boolean;
} {
  return {
    configured: isCloudApiConfigured(),
    phoneNumberId: CLOUD_PHONE_NUMBER_ID,
    graphVersion: CLOUD_GRAPH_VERSION,
    verifyTokenConfigured: Boolean(CLOUD_VERIFY_TOKEN),
    appSecretConfigured: Boolean(cloudAppSecret()),
  };
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

function messagesUrl(): string {
  return `https://graph.facebook.com/${CLOUD_GRAPH_VERSION}/${encodeURIComponent(CLOUD_PHONE_NUMBER_ID)}/messages`;
}

/**
 * Handshake de verificação do webhook (GET da Meta ao cadastrar a URL).
 * Retorna o challenge a devolver com 200, ou null se o token não confere.
 */
export function handleWebhookVerification(
  mode: string | undefined,
  verifyToken: string | undefined,
  challenge: string | undefined,
): string | null {
  if (mode !== 'subscribe') return null;
  if (!CLOUD_VERIFY_TOKEN || verifyToken !== CLOUD_VERIFY_TOKEN) return null;
  return challenge ?? '';
}

/**
 * Valida a assinatura `X-Hub-Signature-256: sha256=<hmac>` do corpo CRU do POST.
 *
 * FALHA FECHADA: sem APP_SECRET configurado, RECUSA tudo.
 *
 * A versão anterior aceitava (fail-open) e isso era uma porta escancarada: a URL
 * do webhook é pública por natureza — quem a descobrisse criaria conversa, queimaria
 * token de IA e injetaria lead falso no painel, e nada no sistema pareceria invasão.
 * Mesma regra do handshake logo acima: sem segredo, sem entrada. Se o health mostrar
 * `appSecretConfigured: false`, o canal está SURDO de propósito, não frouxo.
 */
export function verifyCloudApiSignature(rawBody: string, signatureHeader: string | null | undefined): boolean {
  const secret = cloudAppSecret();
  if (!secret) return false;
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const received = signatureHeader.slice('sha256='.length).trim();
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CloudApiWebhookPayload {
  object?: string;
  entry?: unknown;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Extrai as mensagens de texto de um payload de webhook da Meta.
 * Eventos que não são mensagem (status de entrega, template, etc) retornam [].
 *
 * Formato esperado:
 * { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
 *   value: { contacts: [{profile:{name}, wa_id}], messages: [{from, id, timestamp, type, text:{body}}] } }] }] }
 */
export function parseCloudApiInboundMessages(payload: CloudApiWebhookPayload): CloudApiInboundMessage[] {
  if (payload.object !== 'whatsapp_business_account') return [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const result: CloudApiInboundMessage[] = [];

  for (const entry of entries) {
    const changes = asRecord(entry).changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const changeRec = asRecord(change);
      if (changeRec.field !== 'messages') continue;
      const value = asRecord(changeRec.value);
      // Identifica a CORRETORA: o número que RECEBEU a mensagem.
      const metadata = asRecord(value.metadata);
      const accountId = typeof metadata.phone_number_id === 'string' ? metadata.phone_number_id : undefined;

      // Nome do contato: contacts[] é paralelo a messages[] mas na prática vem 1:1 por evento.
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const nameByWaId = new Map<string, string>();
      for (const contact of contacts) {
        const contactRec = asRecord(contact);
        const waId = typeof contactRec.wa_id === 'string' ? contactRec.wa_id : '';
        const name = asRecord(contactRec.profile).name;
        if (waId && typeof name === 'string' && name.trim()) nameByWaId.set(waId, name.trim());
      }

      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        const messageRec = asRecord(message);
        if (messageRec.type !== 'text') continue; // mídia/áudio: próxima rodada
        const from = typeof messageRec.from === 'string' ? normalizePhone(messageRec.from) : '';
        const text = asRecord(messageRec.text).body;
        if (!from || typeof text !== 'string' || !text.trim()) continue;

        const timestamp = (() => {
          const ts = messageRec.timestamp;
          const parsed = typeof ts === 'string' ? Number(ts) : typeof ts === 'number' ? ts : NaN;
          return Number.isFinite(parsed) ? new Date(parsed * 1000).toISOString() : new Date().toISOString();
        })();

        result.push({
          fromPhone: from,
          text: text.trim(),
          fromSelf: false,
          channelAccountId: accountId,
          pushName: nameByWaId.get(from) ?? nameByWaId.values().next().value,
          messageId: typeof messageRec.id === 'string' ? messageRec.id : undefined,
          timestamp,
        });
      }
    }
  }

  return result;
}

/**
 * Envia mensagem de texto pra um número via Cloud API.
 * Splits longos (> 4096 chars) não tratados aqui — quem chama deve respeitar limite de canal.
 */
export async function sendWhatsappText(toPhone: string, text: string): Promise<SendTextResult> {
  if (!isCloudApiConfigured()) {
    return { ok: false, status: 0, error: 'cloudapi_not_configured' };
  }

  const phone = normalizePhone(toPhone);
  if (!phone) {
    return { ok: false, status: 0, error: 'invalid_phone' };
  }
  if (!text.trim()) {
    return { ok: false, status: 0, error: 'empty_text' };
  }

  try {
    const response = await fetch(messagesUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUD_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { body: text, preview_url: false },
      }),
    });

    const raw = await response.text();
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* deixa string */ }

    if (!response.ok) {
      return { ok: false, status: response.status, body, error: `cloudapi_http_${response.status}` };
    }
    return { ok: true, status: response.status, body };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
