/**
 * Adaptador do WEBCHAT — Fase 4 da unificação.
 *
 * O webchat passa a usar O MESMO motor de conversa do WhatsApp
 * (`core/conversation/turn.ts`). Ele não tem jornada própria: ganha de graça
 * placa, consulta de condutor por CPF, questionário de risco, proposta pendente
 * e pedido de atendente — sem uma linha nova de lógica de conversa.
 *
 * O que é canal aqui:
 *  - IDENTIDADE: no WhatsApp o lead é o telefone; aqui é um id de conversa que
 *    vive num cookie httpOnly. É isso que faz o F5 deixar de matar o lead.
 *  - ENTREGA: o WhatsApp envia mensagem; aqui as falas do bot são ACUMULADAS e
 *    devolvidas na resposta HTTP do mesmo turno.
 */

import { randomUUID } from 'node:crypto';
import {
  runConversationTurn,
  type CoreInbound,
  type TurnResult,
} from '../../core/conversation/turn.js';
import { sessionStore, type SessionState } from '../../session/store.js';

const TENANT_PADRAO = process.env.ROBOCOTE_TENANT_ID?.trim() || 'rpi';

/** Nome do cookie que guarda a identidade da conversa no navegador. */
export const CHAT_COOKIE = 'rc_chat';

/** Id de conversa novo — usado quando o visitante chega sem cookie. */
export function novaConversaId(): string {
  return `wc_${randomUUID()}`;
}

export interface WebchatTurnInput {
  conversationId: string;
  text: string;
  /** Corretora dona do link. Ausente = cai no padrão e a sessão fica marcada. */
  tenantId?: string;
}

export interface WebchatTurnOutput {
  /** Falas do bot neste turno, na ordem — o WhatsApp envia, aqui devolvemos. */
  messages: string[];
  action: TurnResult['action'];
  stepId: SessionState['stepId'] | null;
  completed: boolean;
  quoteGuid: string | null;
  /** Detector: a corretora do link não foi identificada. */
  tenantUnresolved: boolean;
}

/**
 * Roda um turno de webchat pelo motor compartilhado.
 * O `send` do motor vira um coletor: nada sai daqui por conta própria.
 */
export async function runWebchatTurn(input: WebchatTurnInput): Promise<WebchatTurnOutput> {
  const tenantId = input.tenantId?.trim() || TENANT_PADRAO;
  const tenantUnresolved = !input.tenantId?.trim();

  const messages: string[] = [];
  const inbound: CoreInbound = {
    tenantId,
    channel: 'webchat',
    userId: input.conversationId,
    text: input.text,
    timestamp: new Date().toISOString(),
    tenantUnresolved,
  };

  const result = await runConversationTurn(inbound, {
    send: async (text: string) => {
      messages.push(text);
      return { ok: true, status: 200 };
    },
  });

  return {
    messages,
    action: result.action,
    stepId: result.sessionAfter?.stepId ?? null,
    completed: result.sessionAfter?.completed ?? false,
    quoteGuid: result.sessionAfter?.lastGuid ?? null,
    tenantUnresolved,
  };
}

export interface WebchatHistoryItem {
  direction: 'inbound' | 'outbound' | 'system';
  text: string;
  at: string;
}

export interface WebchatSessionView {
  exists: boolean;
  stepId: SessionState['stepId'] | null;
  completed: boolean;
  quoteGuid: string | null;
  history: WebchatHistoryItem[];
}

/**
 * Estado atual da conversa — é o que permite RETOMAR depois do F5.
 * Sem isto, a jornada morava na aba do navegador e sumia junto com ela.
 */
export async function readWebchatSession(
  conversationId: string,
  tenantId?: string,
): Promise<WebchatSessionView> {
  const session = await sessionStore.get({
    tenantId: tenantId?.trim() || TENANT_PADRAO,
    channel: 'webchat',
    channelUserId: conversationId,
  });

  if (!session) {
    return { exists: false, stepId: null, completed: false, quoteGuid: null, history: [] };
  }

  return {
    exists: true,
    stepId: session.stepId,
    completed: session.completed,
    quoteGuid: session.lastGuid,
    history: (session.interactions ?? [])
      .filter((i) => i.direction !== 'system')
      .map((i) => ({
        direction: i.direction,
        text: i.text,
        at: new Date(i.at).toISOString(),
      })),
  };
}
