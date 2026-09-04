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
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import {
  CHAT_COOKIE,
  novaConversaId,
  runWebchatTurn,
  readWebchatSession,
} from '../channels/webchat/adapter.js';
import { planejarInterativo } from '../channels/whatsapp/interativo.js';
import { resolveWebchatTenant } from '../tenant/webchat.js';
import {
  LIMITES_CHAT,
  limitarPorIp,
  permitirTurno,
  marcarVoo,
  liberarVoo,
  respostaExcesso,
} from '../middleware/limites.js';

export const chat = new Hono();

const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const MAX_TEXTO = 2000;
/** Cabeçalho que carrega a identidade da conversa dentro do iframe. */
const HEADER_CONVERSA = 'x-rc-chat';
const FORMATO_CONVERSA = /^wc_[0-9a-f-]{36}$/i;

// Endpoint público em site de terceiro: corpo pequeno e teto por IP antes de
// qualquer trabalho. Cada turno custa IA e, no fim da jornada, cotação real.
chat.use('*', bodyLimit({ maxSize: LIMITES_CHAT.corpoBytes, onError: (c) => respostaExcesso(c) }));
chat.use('*', limitarPorIp);

/**
 * Identidade da conversa. Dentro de um iframe no site da corretora o cookie de
 * terceiro não é confiável (Safari e afins bloqueiam), então o widget guarda o
 * id no próprio localStorage e manda no cabeçalho — que tem prioridade. O
 * cookie continua valendo pra quem abre a página direto (a bancada, por exemplo).
 */
function conversaId(c: Context): string {
  const doHeader = c.req.header(HEADER_CONVERSA)?.trim();
  if (doHeader && FORMATO_CONVERSA.test(doHeader)) {
    c.header(HEADER_CONVERSA, doHeader);
    return doHeader;
  }

  const existente = getCookie(c, CHAT_COOKIE)?.trim();
  if (existente) {
    c.header(HEADER_CONVERSA, existente);
    return existente;
  }

  const novo = novaConversaId();
  c.header(HEADER_CONVERSA, novo);
  setCookie(c, CHAT_COOKIE, novo, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  return novo;
}

/** Corretora dona do link. */
function refDoPedido(c: Context, body?: { tenantId?: string }): string | undefined {
  const doCorpo = body?.tenantId?.trim();
  if (doCorpo) return doCorpo;
  const daQuery = c.req.query('tenant')?.trim();
  return daQuery || undefined;
}

/**
 * Resolve a corretora ou devolve a recusa pronta. Sem dono, ninguém atende: o
 * lead cairia no tenant piloto e apareceria no painel da corretora errada.
 */
async function exigirTenant(
  c: Context,
  body?: { tenantId?: string },
): Promise<{ tenantId: string } | { erro: Response }> {
  const ref = refDoPedido(c, body);
  if (!ref) {
    return { erro: c.json({ ok: false, error: 'tenant obrigatório' }, 400) };
  }
  const tenant = await resolveWebchatTenant(ref);
  if (!tenant) {
    return { erro: c.json({ ok: false, error: 'canal indisponível' }, 404) };
  }
  return { tenantId: tenant.tenantId };
}

chat.post('/turn', async (c) => {
  const body = await c.req.json().catch(() => null) as { text?: string; tenantId?: string } | null;
  const texto = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXTO) : '';
  if (!texto) {
    return c.json({ ok: false, error: 'texto da mensagem é obrigatório' }, 400);
  }
  const dono = await exigirTenant(c, body ?? undefined);
  if ('erro' in dono) return dono.erro;

  const id = conversaId(c);
  if (!permitirTurno(id) || !marcarVoo(id)) return respostaExcesso(c);
  try {
    const resultado = await runWebchatTurn({
      conversationId: id,
      text: texto,
      tenantId: dono.tenantId,
    });
    return c.json({ ok: true, conversationId: id, ...resultado });
  } catch (e) {
    console.error(`[webchat] turno falhou (conversa ${id}): ${(e as Error).message}`);
    return c.json({ ok: false, error: 'não consegui processar sua mensagem agora' }, 500);
  } finally {
    liberarVoo(id);
  }
});

chat.get('/session', async (c) => {
  const dono = await exigirTenant(c);
  if ('erro' in dono) return dono.erro;
  const id = conversaId(c);
  const view = await readWebchatSession(id, dono.tenantId);
  // Na retomada (o F5, o celular que travou), a ÚLTIMA fala do agente reganha os
  // botões: sem isso o lead volta e encara "1️⃣ / 2️⃣" em texto, tendo que digitar
  // o que era um toque. O histórico guarda texto; a escolha se replaneja aqui.
  const historico = view.history ?? [];
  const ultimoIdx = historico.map((h) => h.direction).lastIndexOf('outbound');
  const comChips = historico.map((h, i) => {
    if (i !== ultimoIdx) return h;
    const interativo = planejarInterativo(h.text);
    return interativo ? { ...h, interativo } : h;
  });
  return c.json({ ok: true, conversationId: id, ...view, history: comChips });
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

  const dono = await exigirTenant(c, body ?? undefined);
  if ('erro' in dono) return dono.erro;

  const id = conversaId(c);
  if (!permitirTurno(id) || !marcarVoo(id)) return respostaExcesso(c);
  const tenantId = dono.tenantId;

  return streamSSE(c, async (stream) => {
    try {
      const resultado = await runWebchatTurn(
        { conversationId: id, text: texto, tenantId },
        async (fala) => {
          // Os mesmos botões do WhatsApp, desenhados como chips: o motor fala
          // texto e o planejador diz se aquela fala é uma escolha.
          const interativo = planejarInterativo(fala);
          await stream.writeSSE({
            data: JSON.stringify(interativo ? { tipo: 'msg', texto: fala, interativo } : { tipo: 'msg', texto: fala }),
          });
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
    } finally {
      liberarVoo(id);
    }
  });
});
