/**
 * Rotas do WEBCHAT com sessão no servidor (Fase 4).
 *
 * O webchat antigo mantinha a conversa inteira dentro da aba do navegador: F5,
 * sinal caindo ou celular travando matavam o lead sem deixar rastro, e nenhuma
 * conversa virava card no painel. Aqui a conversa vive no servidor, identificada
 * por um cookie httpOnly, e usa o MESMO motor do WhatsApp.
 *
 * Rotas:
 *   POST /api/chat/turn        — manda uma mensagem, recebe as falas do bot
 *   POST /api/chat/turn/stream — igual, mas cada fala chega na hora (SSE)
 *   GET  /api/chat/session  — retoma a conversa (o conserto do F5)
 *   POST /api/chat/reset    — descarta a conversa e começa outra
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import {
  CHAT_COOKIE,
  novaConversaId,
  runWebchatTurn,
  readWebchatSession,
} from '../channels/webchat/adapter.js';

export const chat = new Hono();

const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const MAX_TEXTO = 2000;

/** Identidade da conversa: lê do cookie ou cria uma nova e devolve pro navegador. */
function conversaId(c: Context): string {
  const existente = getCookie(c, CHAT_COOKIE)?.trim();
  if (existente) return existente;

  const novo = novaConversaId();
  setCookie(c, CHAT_COOKIE, novo, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  return novo;
}

/** Corretora dona do link — por enquanto vem explícita; depois virá do host/slug. */
function tenantDoPedido(c: Context, body?: { tenantId?: string }): string | undefined {
  const doCorpo = body?.tenantId?.trim();
  if (doCorpo) return doCorpo;
  const daQuery = c.req.query('tenant')?.trim();
  return daQuery || undefined;
}

chat.post('/turn', async (c) => {
  const body = await c.req.json().catch(() => null) as { text?: string; tenantId?: string } | null;
  const texto = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXTO) : '';
  if (!texto) {
    return c.json({ ok: false, error: 'texto da mensagem é obrigatório' }, 400);
  }

  const id = conversaId(c);
  try {
    const resultado = await runWebchatTurn({
      conversationId: id,
      text: texto,
      tenantId: tenantDoPedido(c, body ?? undefined),
    });
    return c.json({ ok: true, ...resultado });
  } catch (e) {
    console.error(`[webchat] turno falhou (conversa ${id}): ${(e as Error).message}`);
    return c.json({ ok: false, error: 'não consegui processar sua mensagem agora' }, 500);
  }
});

chat.get('/session', async (c) => {
  const id = conversaId(c);
  const view = await readWebchatSession(id, tenantDoPedido(c));
  return c.json({ ok: true, conversationId: id, ...view });
});

chat.post('/reset', (c) => {
  deleteCookie(c, CHAT_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

/**
 * Mesma coisa que /turn, mas as falas do bot chegam UMA A UMA, no instante em
 * que o motor as produz. Existe por causa da cotação: ela pode levar dezenas de
 * segundos consultando seguradoras, e deixar o lead diante de uma tela parada
 * nesse intervalo é o jeito mais rápido de perdê-lo.
 *
 * Protocolo: eventos SSE com JSON.
 *   {tipo:'msg',  texto}                          — uma fala do bot
 *   {tipo:'fim',  action, stepId, completed, ...} — encerramento do turno
 *   {tipo:'erro', erro}                           — falhou
 */
chat.post('/turn/stream', async (c) => {
  const body = await c.req.json().catch(() => null) as { text?: string; tenantId?: string } | null;
  const texto = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXTO) : '';
  if (!texto) {
    return c.json({ ok: false, error: 'texto da mensagem é obrigatório' }, 400);
  }

  const id = conversaId(c);
  const tenantId = tenantDoPedido(c, body ?? undefined);

  return streamSSE(c, async (stream) => {
    try {
      const resultado = await runWebchatTurn(
        { conversationId: id, text: texto, tenantId },
        async (fala) => {
          await stream.writeSSE({ data: JSON.stringify({ tipo: 'msg', texto: fala }) });
        },
      );
      await stream.writeSSE({
        data: JSON.stringify({
          tipo: 'fim',
          action: resultado.action,
          stepId: resultado.stepId,
          completed: resultado.completed,
          quoteGuid: resultado.quoteGuid,
          tenantUnresolved: resultado.tenantUnresolved,
        }),
      });
    } catch (e) {
      console.error(`[webchat] turno em stream falhou (conversa ${id}): ${(e as Error).message}`);
      await stream.writeSSE({
        data: JSON.stringify({ tipo: 'erro', erro: 'não consegui processar sua mensagem agora' }),
      });
    }
  });
});
