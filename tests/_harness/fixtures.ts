/**
 * Fábricas e normalizadores da rede de testes.
 * Não importa nada de `src/` estaticamente — só tipos, que somem na compilação.
 */

import type { WhatsappInboundMessage } from '../../src/channels/whatsapp/transport.js';

/** Telefone único por teste — dispensa limpar o store entre casos. */
export function phone(n: number): string {
  return `55489999${String(n).padStart(5, '0')}`;
}

/** Inbound mínimo. `timestamp` é obrigatório no contrato — não montar à mão. */
export function inbound(
  text: string,
  over: Partial<WhatsappInboundMessage> = {},
): WhatsappInboundMessage {
  return {
    fromPhone: over.fromPhone ?? phone(1),
    text,
    fromSelf: over.fromSelf ?? false,
    pushName: over.pushName,
    messageId: over.messageId,
    timestamp: over.timestamp ?? new Date(0).toISOString(),
  };
}

/** Timestamp de N horas atrás — para exercitar os relógios de negócio. */
export function agoMs(horas: number): number {
  return Date.now() - horas * 60 * 60 * 1000;
}

interface InteractionLike {
  id?: string;
  at?: number;
  direction?: string;
  text?: string;
  action?: string;
}

/**
 * Zera id e timestamp das interações. OBRIGATÓRIO antes de qualquer snapshot:
 * o store gera id com `Date.now()` + `Math.random()` (store.ts) — sem isso o
 * teste passa hoje e falha amanhã, que é o pior tipo de instabilidade.
 */
export function normalize(interactions: InteractionLike[] | undefined): Array<Record<string, unknown>> {
  return (interactions ?? []).map((i) => ({
    direction: i.direction,
    action: i.action ?? null,
    text: i.text,
  }));
}
