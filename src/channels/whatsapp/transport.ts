/**
 * Fachada de transporte WhatsApp — o orquestrador fala com ELA, nunca com um canal direto.
 *
 * Canais disponíveis:
 *  - 'cloudapi'  → API oficial da Meta (Cloud API). Canal padrão do produto (decisão 2026-08-23).
 *  - 'evolution' → Evolution API (não-oficial, QR). Legado em extinção; some quando o último cliente migrar.
 *
 * Seleção:
 *  - WHATSAPP_CHANNEL=cloudapi|evolution força o canal explicitamente.
 *  - Sem env: auto — usa cloudapi se configurado, senão cai pro evolution (back-compat).
 */

import * as cloudapi from './cloudapi.js';
import * as evolution from './evolution.js';

/** Contrato neutro de mensagem inbound — mesmo shape nos dois canais. */
export interface WhatsappInboundMessage {
  /** Telefone do remetente, formato E.164 sem o "+". Ex: "5511999998888" */
  fromPhone: string;
  /** Texto da mensagem. */
  text: string;
  /** true só no evolution (eco de mensagem própria); cloudapi nunca ecoa. */
  fromSelf: boolean;
  /** Nome do contato no WhatsApp, se disponível. */
  pushName?: string;
  /** ID original da mensagem no canal — útil pra rastreio. */
  messageId?: string;
  /** Timestamp ISO. */
  timestamp: string;
  /**
   * Conta do canal em que a mensagem chegou — o que identifica a CORRETORA.
   * Evolution: nome da instância. Cloud API: `metadata.phone_number_id`.
   * Opcional por compatibilidade com quem ainda não propaga.
   */
  channelAccountId?: string;
}

export interface SendTextResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

export type WhatsappChannel = 'cloudapi' | 'evolution';

const CHANNEL_ENV = process.env.WHATSAPP_CHANNEL?.trim().toLowerCase() ?? '';

export function getActiveWhatsappChannel(): WhatsappChannel {
  if (CHANNEL_ENV === 'cloudapi' || CHANNEL_ENV === 'evolution') return CHANNEL_ENV;
  return cloudapi.isCloudApiConfigured() ? 'cloudapi' : 'evolution';
}

/** Envia texto pelo canal ativo. */
export async function sendWhatsappText(toPhone: string, text: string): Promise<SendTextResult> {
  return getActiveWhatsappChannel() === 'cloudapi'
    ? cloudapi.sendWhatsappText(toPhone, text)
    : evolution.sendWhatsappText(toPhone, text);
}

/**
 * Dedup anti-eco: só faz sentido no evolution (webhook devolve o que o bot mandou).
 * No cloudapi o webhook nunca traz mensagem do bot — sempre false.
 */
export function wasMessageSentByBot(fromPhone: string, text: string): boolean {
  return getActiveWhatsappChannel() === 'evolution'
    ? evolution.wasMessageSentByBot(fromPhone, text)
    : false;
}
