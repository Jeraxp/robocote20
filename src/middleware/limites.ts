/**
 * Limites do canal público (webchat embutido em site de terceiro).
 *
 * O /api/chat fica fora do login do painel por natureza — quem fala é o lead,
 * anônimo, a partir do site da corretora. Cada turno pode acionar a IA e, no
 * fim da jornada, uma cotação REAL nas seguradoras. Sem teto, um script bobo
 * vira custo e lead falso no painel do cliente. Guard-rail é o produto.
 *
 * Três alçadas, todas em memória (janela deslizante num Map com poda):
 *   - por IP: pedidos por minuto (X-Forwarded-For 1º hop — estamos atrás do proxy);
 *   - por conversa: turnos por minuto;
 *   - por conversa: UM turno em voo por vez (evita cotação em paralelo).
 *
 * Multi-réplica: o Map é por processo. Aceitável como 1ª camada; endurecer com
 * tabela quando houver mais de uma réplica atendendo o webchat.
 */

import type { Context, Next } from 'hono';

export const LIMITES_CHAT = {
  /** Pedidos por minuto por IP (qualquer rota do chat). */
  porIpPorMinuto: 30,
  /** Turnos por minuto por conversa. */
  turnosPorMinuto: 20,
  /** Tamanho máximo do corpo JSON de um turno. */
  corpoBytes: 8 * 1024,
  janelaMs: 60_000,
} as const;

export const MENSAGEM_EXCESSO = 'muitas mensagens — espere um instante';

/** Janela deslizante: guarda os instantes de cada chave e poda o que já saiu da janela. */
class JanelaDeslizante {
  private readonly batidas = new Map<string, number[]>();
  private ultimaPoda = Date.now();

  constructor(private readonly janelaMs: number) {}

  /** Registra a batida e diz se ainda cabe no limite. */
  permitir(chave: string, limite: number, agora = Date.now()): boolean {
    this.podarSePreciso(agora);
    const corte = agora - this.janelaMs;
    const lista = (this.batidas.get(chave) ?? []).filter((t) => t > corte);
    if (lista.length >= limite) {
      this.batidas.set(chave, lista);
      return false;
    }
    lista.push(agora);
    this.batidas.set(chave, lista);
    return true;
  }

  /** Poda global de tempos em tempos — chaves paradas não podem crescer pra sempre. */
  private podarSePreciso(agora: number): void {
    if (agora - this.ultimaPoda < this.janelaMs) return;
    this.ultimaPoda = agora;
    const corte = agora - this.janelaMs;
    for (const [chave, lista] of this.batidas) {
      const viva = lista.filter((t) => t > corte);
      if (viva.length === 0) this.batidas.delete(chave);
      else this.batidas.set(chave, viva);
    }
  }

  limpar(): void {
    this.batidas.clear();
  }
}

const porIp = new JanelaDeslizante(LIMITES_CHAT.janelaMs);
const porConversa = new JanelaDeslizante(LIMITES_CHAT.janelaMs);
const emVoo = new Set<string>();

/** IP do cliente: 1º hop do X-Forwarded-For (Traefik na frente); sem proxy, 'local'. */
export function ipDoPedido(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  const primeiro = xff?.split(',')[0]?.trim();
  if (primeiro) return primeiro;
  return c.req.header('x-real-ip')?.trim() || 'local';
}

export function respostaExcesso(c: Context): Response {
  c.header('Retry-After', '10');
  return c.json({ ok: false, error: MENSAGEM_EXCESSO }, 429);
}

/** Middleware: teto de pedidos por minuto por IP. */
export async function limitarPorIp(c: Context, next: Next): Promise<Response | void> {
  if (!porIp.permitir(ipDoPedido(c), LIMITES_CHAT.porIpPorMinuto)) {
    return respostaExcesso(c);
  }
  await next();
}

/** Teto de turnos por minuto de uma conversa. */
export function permitirTurno(conversationId: string): boolean {
  return porConversa.permitir(conversationId, LIMITES_CHAT.turnosPorMinuto);
}

/**
 * Marca a conversa como "turno em voo". Devolve false se já havia um — o
 * chamador responde 429 sem tocar o motor. Sempre parear com `liberarVoo`.
 */
export function marcarVoo(conversationId: string): boolean {
  if (emVoo.has(conversationId)) return false;
  emVoo.add(conversationId);
  return true;
}

export function liberarVoo(conversationId: string): void {
  emVoo.delete(conversationId);
}

/** Zera tudo — só pra testes. */
export function resetLimites(): void {
  porIp.limpar();
  porConversa.limpar();
  emVoo.clear();
}
