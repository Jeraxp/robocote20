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

export interface EvolutionCreateInstanceInput {
  instanceName: string;
  ownerPhone?: string;
}

export interface EvolutionCreateInstanceResult {
  ok: boolean;
  status: number;
  instanceName: string;
  body?: unknown;
  error?: string;
}

export interface EvolutionConnectResult {
  ok: boolean;
  status: number;
  instanceName: string;
  pairingCode?: string;
  code?: string;
  base64?: string;
  count?: number;
  body?: unknown;
  error?: string;
}

export interface EvolutionConnectionStateResult {
  ok: boolean;
  status: number;
  instanceName: string;
  state?: string;
  body?: unknown;
  error?: string;
}

function instanceCreateUrl(): string {
  return new URL('/instance/create', EVOLUTION_BASE_URL).toString();
}

function instanceConnectUrl(instanceName: string): string {
  return new URL(`/instance/connect/${encodeURIComponent(instanceName)}`, EVOLUTION_BASE_URL).toString();
}

function instanceStateUrl(instanceName: string): string {
  return new URL(`/instance/connectionState/${encodeURIComponent(instanceName)}`, EVOLUTION_BASE_URL).toString();
}

async function readEvolutionBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function bodyNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' ? value : undefined;
}

function firstBodyString(...values: Array<Record<string, unknown>>): string | undefined {
  for (const body of values) {
    const value = bodyString(body, 'base64')
      ?? bodyString(body, 'qrcode')
      ?? bodyString(body, 'qrCode');
    if (value) return value;
  }
  return undefined;
}

export async function createEvolutionInstance(input: EvolutionCreateInstanceInput): Promise<EvolutionCreateInstanceResult> {
  if (!isEvolutionConfigured()) {
    return { ok: false, status: 0, instanceName: input.instanceName, error: 'evolution_not_configured' };
  }

  try {
    const response = await fetch(instanceCreateUrl(), {
      method: 'POST',
      headers: {
        apikey: EVOLUTION_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instanceName: input.instanceName,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        number: input.ownerPhone,
        rejectCall: true,
        groupsIgnore: true,
        readMessages: false,
        readStatus: false,
        syncFullHistory: false,
      }),
    });

    const body = await readEvolutionBody(response);
    return {
      ok: response.ok,
      status: response.status,
      instanceName: input.instanceName,
      body,
      error: response.ok ? undefined : `evolution_http_${response.status}`,
    };
  } catch (e) {
    return { ok: false, status: 0, instanceName: input.instanceName, error: (e as Error).message };
  }
}

export async function connectEvolutionInstance(instanceName: string): Promise<EvolutionConnectResult> {
  if (!isEvolutionConfigured()) {
    return { ok: false, status: 0, instanceName, error: 'evolution_not_configured' };
  }

  try {
    const response = await fetch(instanceConnectUrl(instanceName), {
      method: 'GET',
      headers: { apikey: EVOLUTION_API_KEY },
    });
    const body = await readEvolutionBody(response);
    const record = bodyRecord(body);
    const qrcode = bodyRecord(record.qrcode);
    const qrCode = bodyRecord(record.qrCode);
    return {
      ok: response.ok,
      status: response.status,
      instanceName,
      pairingCode: bodyString(record, 'pairingCode'),
      code: bodyString(record, 'code') ?? bodyString(qrcode, 'code') ?? bodyString(qrCode, 'code'),
      base64: bodyString(record, 'base64') ?? bodyString(qrcode, 'base64') ?? bodyString(qrCode, 'base64') ?? firstBodyString(qrcode, qrCode),
      count: bodyNumber(record, 'count'),
      body,
      error: response.ok ? undefined : `evolution_http_${response.status}`,
    };
  } catch (e) {
    return { ok: false, status: 0, instanceName, error: (e as Error).message };
  }
}

export async function getEvolutionConnectionState(instanceName: string): Promise<EvolutionConnectionStateResult> {
  if (!isEvolutionConfigured()) {
    return { ok: false, status: 0, instanceName, error: 'evolution_not_configured' };
  }

  try {
    const response = await fetch(instanceStateUrl(instanceName), {
      method: 'GET',
      headers: { apikey: EVOLUTION_API_KEY },
    });
    const body = await readEvolutionBody(response);
    const record = bodyRecord(body);
    const nested = bodyRecord(record.instance);
    return {
      ok: response.ok,
      status: response.status,
      instanceName,
      state: bodyString(record, 'state') ?? bodyString(record, 'status') ?? bodyString(nested, 'state') ?? bodyString(nested, 'status'),
      body,
      error: response.ok ? undefined : `evolution_http_${response.status}`,
    };
  } catch (e) {
    return { ok: false, status: 0, instanceName, error: (e as Error).message };
  }
}

/**
 * Cache de mensagens outbound enviadas pelo BOT — usado pra distinguir bot vs operador
 * humano quando webhook entrega evento com `fromSelf=true`. Se o texto bate com algo
 * aqui dentro da janela TTL, foi o bot. Se não bate, foi um humano (operador da corretora
 * mandou via WhatsApp Web, app, ou outro canal vinculado ao mesmo número).
 *
 * In-memory por simplicidade — janela TTL é curta (Evolution propaga webhook em segundos).
 * Restart do container perde o cache; na pior das hipóteses, uma mensagem que o bot mandou
 * 5min antes do restart vai parecer "humano" — aceitável pro MVP. Se virar problema, migra
 * pro Redis.
 *
 * Estrutura: chave = `${phoneNormalized}::${textNormalized}`. Valor = timestamp expira.
 */
const BOT_OUTBOUND_CACHE = new Map<string, number>();
const BOT_OUTBOUND_TTL_MS = 5 * 60 * 1000; // 5min

function normalizeForCache(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function cacheKey(phone: string, text: string): string {
  return `${normalizePhone(phone)}::${normalizeForCache(text)}`;
}

function cleanExpiredOutbound(): void {
  const now = Date.now();
  for (const [k, expiresAt] of BOT_OUTBOUND_CACHE.entries()) {
    if (expiresAt < now) BOT_OUTBOUND_CACHE.delete(k);
  }
}

/** Marca que o BOT enviou esse texto pra esse telefone (chamado pelo `sendWhatsappText`). */
export function markBotSentMessage(toPhone: string, text: string): void {
  cleanExpiredOutbound();
  BOT_OUTBOUND_CACHE.set(cacheKey(toPhone, text), Date.now() + BOT_OUTBOUND_TTL_MS);
}

/**
 * Verifica se um texto que chegou via webhook `fromSelf=true` foi enviado pelo BOT
 * (true) ou por um operador humano externo (false). A janela é os últimos 5min.
 */
export function wasMessageSentByBot(fromPhone: string, text: string): boolean {
  cleanExpiredOutbound();
  const key = cacheKey(fromPhone, text);
  const expiresAt = BOT_OUTBOUND_CACHE.get(key);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    BOT_OUTBOUND_CACHE.delete(key);
    return false;
  }
  // Consome o registro pra evitar falso positivo se o operador mandar a MESMA frase depois
  BOT_OUTBOUND_CACHE.delete(key);
  return true;
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

  // Marca ANTES do fetch — webhook pode chegar antes da resposta HTTP retornar.
  markBotSentMessage(phone, text);

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
