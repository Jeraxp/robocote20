import 'dotenv/config';
import { io, type Socket } from 'socket.io-client';
import { dumpJSON } from '../utils/logger.js';

const SOCKET_URL = process.env.SEGFY_SOCKET_URL ?? 'https://socket-io.segfy.com';

export interface SocketEvent {
  action?: 'STEP' | 'PDF' | 'RESULT' | string;
  status?: 'STEP' | 'PDF' | 'RESULT' | string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SocketSession {
  roomId: string;
  socket: Socket;
  events: SocketEvent[];
  closedAt: number | null;
}

/**
 * Conecta no socket.io da Segfy e fica escutando o canal `roomId` (UUID nosso,
 * o mesmo enviado em `config.callback` na chamada de `/calculate`).
 *
 * Doc oficial Segfy: a conexão deve ser aberta ANTES de chamar `/calculate` —
 * senão eventos publicados nesse meio-tempo são perdidos.
 *
 * Eventos chegam com 3 tipos no campo `action`:
 * - `STEP`   — progresso ("consultando Porto Seguro...")
 * - `PDF`    — documento gerado depois do RESULT
 * - `RESULT` — cotação real de 1 seguradora
 */
export function openSocket(roomId: string, onEvent?: (e: SocketEvent) => void): SocketSession {
  const session: SocketSession = {
    roomId,
    socket: io(SOCKET_URL, {
      transports: ['websocket'],
      auth: { roomId },
    }),
    events: [],
    closedAt: null,
  };

  session.socket.on('connect', () => {
    console.log(`🔌 socket.io conectado (room ${roomId.slice(0, 8)}...)`);
  });

  session.socket.on('connect_error', (err: Error) => {
    console.warn(`⚠️  socket.io connect_error: ${err.message}`);
  });

  session.socket.on(roomId, (message: SocketEvent) => {
    session.events.push(message);
    console.log(`   📨 evento ${message?.action ?? message?.status ?? 'unknown'} (total: ${session.events.length})`);
    if (onEvent) onEvent(message);
  });

  session.socket.on('disconnect', (reason: string) => {
    session.closedAt = Date.now();
    console.log(`🔌 socket.io desconectado (room ${roomId.slice(0, 8)}, motivo: ${reason})`);
  });

  return session;
}

/**
 * Aguarda o handshake do socket.io antes do calculate. A Segfy publica eventos
 * imediatamente; se esse passo falhar, é melhor abortar do que perder RESULT.
 */
export async function waitForSocketConnect(session: SocketSession, timeoutMs = 5000): Promise<void> {
  if (session.socket.connected) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`socket.io não conectou em ${timeoutMs}ms`));
    }, timeoutMs);

    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new Error(`socket.io connect_error: ${err.message}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      session.socket.off('connect', onConnect);
      session.socket.off('connect_error', onError);
    };

    session.socket.once('connect', onConnect);
    session.socket.once('connect_error', onError);
  });
}

/**
 * Fecha o socket e persiste todos os eventos coletados em um único JSON.
 */
export async function closeSocket(session: SocketSession, logName?: string): Promise<SocketEvent[]> {
  session.socket.disconnect();
  session.closedAt = Date.now();
  if (logName) {
    await dumpJSON(`socket__${logName}`, {
      roomId: session.roomId,
      eventCount: session.events.length,
      events: session.events,
    });
  }
  return session.events;
}

/**
 * Helper: abre socket + aguarda `timeoutMs` recebendo eventos + fecha + retorna tudo.
 * Útil pra spike — em produção a gente abre, dispara `/calculate`, e fica escutando
 * assincronamente até detectar que todas seguradoras responderam.
 */
export async function listenFor(
  roomId: string,
  timeoutMs: number,
  logName?: string,
): Promise<SocketEvent[]> {
  const session = openSocket(roomId);
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  return closeSocket(session, logName);
}
