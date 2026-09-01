/**
 * Fachada de transporte WhatsApp — o orquestrador fala com ELA, nunca com um canal direto.
 *
 * Canais disponíveis:
 *  - 'gateway'   → gateway oficial da Taskdun (arquitetura A, contrato v2 de 30/08/2026).
 *                  O gateway é dono do número e do token da Meta; o motor só conversa.
 *                  PADRÃO do produto daqui pra frente.
 *  - 'cloudapi'  → fala direto com a Graph API da Meta. Só para número que o motor
 *                  possua sozinho, sem gateway na frente.
 *  - 'evolution' → API não-oficial, QR. Legado em extinção; some quando o último cliente migrar.
 *
 * Seleção:
 *  - WHATSAPP_CHANNEL=gateway|cloudapi|evolution força o canal explicitamente.
 *  - Sem env: auto — gateway se configurado, senão cloudapi se configurado, senão evolution.
 *
 * Observação de ENTRADA: com o gateway na frente, o webhook continua chegando no
 * formato NATIVO da Meta (o gateway repassa os bytes exatos, reassinados). Por isso
 * o parser de `cloudapi.ts` serve aos dois — só o ENVIO muda de porta.
 */

import * as cloudapi from './cloudapi.js';
import * as evolution from './evolution.js';
import * as gateway from './gateway.js';

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
  /** Tipo da mensagem quando não é texto (audio/image/document…). Só cloudapi/gateway preenchem. */
  unsupportedType?: string;
}

export interface SendTextResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

export type WhatsappChannel = 'gateway' | 'cloudapi' | 'evolution';

/** Lido na HORA da chamada — env congelada em const é intestável e amarra o boot. */
function channelEnv(): string {
  return process.env.WHATSAPP_CHANNEL?.trim().toLowerCase() ?? '';
}

export function getActiveWhatsappChannel(): WhatsappChannel {
  const forcado = channelEnv();
  if (forcado === 'gateway' || forcado === 'cloudapi' || forcado === 'evolution') return forcado;
  if (gateway.isGatewayConfigured()) return 'gateway';
  return cloudapi.isCloudApiConfigured() ? 'cloudapi' : 'evolution';
}

/** Envia texto pelo canal ativo. */
export async function sendWhatsappText(toPhone: string, text: string): Promise<SendTextResult> {
  switch (getActiveWhatsappChannel()) {
    case 'gateway':
      return gateway.sendWhatsappText(toPhone, text);
    case 'cloudapi':
      return cloudapi.sendWhatsappText(toPhone, text);
    default:
      return evolution.sendWhatsappText(toPhone, text);
  }
}

/**
 * Dedup anti-eco: só faz sentido no evolution (webhook devolve o que o bot mandou).
 * Nos canais oficiais (gateway/cloudapi) o webhook nunca traz mensagem do bot — sempre false.
 */
export function wasMessageSentByBot(fromPhone: string, text: string): boolean {
  return getActiveWhatsappChannel() === 'evolution'
    ? evolution.wasMessageSentByBot(fromPhone, text)
    : false;
}
