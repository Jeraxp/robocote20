/**
 * Transporte via GATEWAY oficial (arquitetura A, contrato v2 de 30/08/2026).
 *
 * Quem faz o quê: o motor é o cérebro da conversa; o gateway é o carteiro oficial.
 * O token da Meta vive no cofre do gateway — o motor NUNCA toca a Graph API.
 *
 * Entrada (não é aqui, é no webhook): o gateway repassa os bytes exatos que a Meta
 * entregou, reassinados com HMAC-SHA256 hex do segredo compartilhado. Por isso o
 * parser nativo em `cloudapi.ts` continua servindo sem uma linha nova.
 *
 * Saída (é aqui): POST {BASE}/api/v1/robocote/mensagens
 *   header  x-motor-api-key: <chave própria desta porta>
 *   corpo   { "para": "5548988326647", "texto": "..." }
 *   200     { "enviada": true, "meta_message_id": "wamid..." }
 *
 * ATENÇÃO À VERDADE DO "ENVIADO": `enviada: true` significa que a Meta ACEITOU,
 * não que a pessoa RECEBEU. Fora da janela de 24h a Meta aceita e depois manda
 * `failed` pelo webhook de status. É o mesmo "SMTP aceito ≠ entregue" que nos
 * custou caro em agosto — quem quiser certeza tem que ler o status, não o 200.
 *
 * Config via env:
 * - ROBOCOTE_GATEWAY_URL       base do gateway (ex: https://host.exemplo)
 * - ROBOCOTE_GATEWAY_API_KEY   chave do header x-motor-api-key
 * - ROBOCOTE_GATEWAY_TIMEOUT_MS (opcional, default 15000)
 */

export interface SendTextResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
  /** wamid devolvido pelo gateway — a única prova de que a Meta aceitou. */
  messageId?: string;
}

/** Teto do contrato. Trabalhamos abaixo dele pra sobrar folga. */
const LIMITE_TEXTO = 4000;

function baseUrl(): string {
  return (process.env.ROBOCOTE_GATEWAY_URL?.trim() ?? '').replace(/\/+$/, '');
}

function apiKey(): string {
  return process.env.ROBOCOTE_GATEWAY_API_KEY?.trim() ?? '';
}

function timeoutMs(): number {
  const bruto = Number(process.env.ROBOCOTE_GATEWAY_TIMEOUT_MS ?? '');
  return Number.isFinite(bruto) && bruto > 0 ? bruto : 15000;
}

export function isGatewayConfigured(): boolean {
  return Boolean(baseUrl() && apiKey());
}

export function getGatewayConfig(): {
  configured: boolean;
  baseUrl: string;
  apiKeyConfigured: boolean;
  timeoutMs: number;
} {
  return {
    configured: isGatewayConfigured(),
    baseUrl: baseUrl(),
    apiKeyConfigured: Boolean(apiKey()),
    timeoutMs: timeoutMs(),
  };
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Quebra texto acima do teto do contrato em pedaços enviáveis.
 *
 * Por que isto existe: resultado de cotação com várias seguradoras estoura 4096
 * com facilidade. Sem quebrar, o gateway devolve 400 e o lead recebe NADA —
 * falha silenciosa justo no momento mais valioso da conversa. Quebrar em duas
 * mensagens é pior que uma; receber zero é MUITO pior que duas.
 *
 * Corta em fronteira natural (parágrafo > linha > espaço) pra não partir palavra.
 */
export function splitForWhatsapp(text: string, limite: number = LIMITE_TEXTO): string[] {
  if (text.length <= limite) return [text];
  const partes: string[] = [];
  let resto = text;
  while (resto.length > limite) {
    const janela = resto.slice(0, limite);
    let corte = janela.lastIndexOf('\n\n');
    if (corte < limite * 0.5) corte = janela.lastIndexOf('\n');
    if (corte < limite * 0.5) corte = janela.lastIndexOf(' ');
    if (corte < limite * 0.5) corte = limite; // texto sem respiro: corta seco
    partes.push(resto.slice(0, corte).trimEnd());
    resto = resto.slice(corte).trimStart();
  }
  if (resto) partes.push(resto);
  return partes;
}

async function postMensagem(para: string, texto: string): Promise<SendTextResult> {
  const base = baseUrl();
  const chave = apiKey();
  if (!base || !chave) {
    return { ok: false, status: 0, error: 'gateway_nao_configurado' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    const resp = await fetch(`${base}/api/v1/robocote/mensagens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-motor-api-key': chave },
      body: JSON.stringify({ para, texto }),
      signal: ctrl.signal,
    });

    let body: unknown;
    const cru = await resp.text();
    try {
      body = cru ? JSON.parse(cru) : undefined;
    } catch {
      body = cru;
    }

    if (!resp.ok) {
      // 400 destino/texto inválido · 401 chave errada · 503 tenant não configurado lá.
      const msg = (body as { message?: string } | undefined)?.message;
      return { ok: false, status: resp.status, body, error: msg || `http_${resp.status}` };
    }

    const dados = (body ?? {}) as { enviada?: boolean; meta_message_id?: string };
    return {
      ok: dados.enviada !== false,
      status: resp.status,
      body,
      messageId: dados.meta_message_id,
    };
  } catch (e) {
    const err = e as Error;
    const abortado = err.name === 'AbortError';
    return { ok: false, status: 0, error: abortado ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envia texto pelo número oficial, via gateway.
 * Texto acima do teto vira várias mensagens, em ordem. Se um pedaço falhar,
 * para ali e reporta — mandar o fim sem o começo confunde mais que o silêncio.
 */
export async function sendWhatsappText(toPhone: string, text: string): Promise<SendTextResult> {
  const para = normalizePhone(toPhone);
  if (!para) return { ok: false, status: 0, error: 'destino_invalido' };
  if (!text?.trim()) return { ok: false, status: 0, error: 'texto_vazio' };

  const partes = splitForWhatsapp(text);
  let ultimo: SendTextResult = { ok: false, status: 0, error: 'nada_enviado' };
  for (const parte of partes) {
    ultimo = await postMensagem(para, parte);
    if (!ultimo.ok) return ultimo;
  }
  return ultimo;
}
