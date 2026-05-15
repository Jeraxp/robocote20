import 'dotenv/config';
import { getBearer } from './auth.js';
import { dumpJSON } from '../utils/logger.js';
import { redactDeep, redactString } from '../utils/redact.js';

const BASE_URL = process.env.SEGFY_BASE_URL ?? 'https://api.automation.segfy.com';
const CORRETORA_TOKEN = process.env.RPI_CORRETORA_TOKEN ?? '';

if (!CORRETORA_TOKEN) {
  console.warn('⚠️  RPI_CORRETORA_TOKEN não definido — chamadas protegidas devem retornar 401/VALIDACAO');
}

export type TokenTransport =
  | 'none'
  | 'query_corretora_token'
  | 'query_token'
  | 'body_corretora_token'
  | 'body_token'
  | 'body_config_token';

export interface SegfyResponse<T = unknown> {
  ok: boolean;
  status: number;
  contentType: string | null;
  timeMs: number;
  body: T;
  url: string;
  transport: TokenTransport;
}

interface SegfyRequestOptions {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: Record<string, unknown>;
  tokenTransport?: TokenTransport;
  logName?: string;
}

function withTokenInBody(
  bodyData: Record<string, unknown>,
  tokenTransport: TokenTransport,
): Record<string, unknown> {
  if (!CORRETORA_TOKEN) return bodyData;
  if (tokenTransport === 'body_corretora_token') {
    return { ...bodyData, corretora_token: CORRETORA_TOKEN };
  }
  if (tokenTransport === 'body_token') {
    return { ...bodyData, token: CORRETORA_TOKEN };
  }
  if (tokenTransport === 'body_config_token') {
    const config = typeof bodyData.config === 'object' && bodyData.config !== null ? bodyData.config : {};
    return { ...bodyData, config: { ...config, token: CORRETORA_TOKEN } };
  }
  return bodyData;
}

function withTokenInQuery(url: URL, tokenTransport: TokenTransport): void {
  if (!CORRETORA_TOKEN) return;
  if (tokenTransport === 'query_corretora_token') {
    url.searchParams.set('corretora_token', CORRETORA_TOKEN);
  }
  if (tokenTransport === 'query_token') {
    url.searchParams.set('token', CORRETORA_TOKEN);
  }
}

async function parseBody(res: Response): Promise<{ body: unknown; contentType: string | null }> {
  const contentType = res.headers.get('content-type');
  const text = await res.text();
  if (contentType?.includes('application/json')) {
    try {
      return { body: redactDeep(JSON.parse(text)), contentType };
    } catch {
      return { body: redactString(text), contentType };
    }
  }
  return { body: redactString(text), contentType };
}

export async function segfyRequest<T = unknown>({
  method,
  path,
  query = {},
  body = {},
  tokenTransport = method === 'GET' ? 'query_corretora_token' : 'body_corretora_token',
  logName,
}: SegfyRequestOptions): Promise<SegfyResponse<T>> {
  const bearer = await getBearer();
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  withTokenInQuery(url, tokenTransport);

  const payload = withTokenInBody(body, tokenTransport);
  const start = Date.now();
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
  });
  const timeMs = Date.now() - start;
  const { body: responseBody, contentType } = await parseBody(res);

  const result: SegfyResponse<T> = {
    ok: res.ok,
    status: res.status,
    contentType,
    timeMs,
    body: responseBody as T,
    url: redactString(url.toString(), [bearer]),
    transport: tokenTransport,
  };

  if (logName) {
    await dumpJSON(`${method.toLowerCase()}__${logName}`, {
      request: {
        method,
        url: url.toString(),
        transport: tokenTransport,
        body: method === 'POST' ? payload : undefined,
      },
      response: result,
    });
  }
  console.log(`→ ${method} ${path} (${timeMs}ms) HTTP ${res.status} [${tokenTransport}]`);
  return result;
}

export async function segfyGET<T = unknown>(
  path: string,
  query: Record<string, string | number | boolean> = {},
  logName?: string,
  tokenTransport: TokenTransport = 'query_corretora_token',
): Promise<SegfyResponse<T>> {
  return segfyRequest<T>({ method: 'GET', path, query, logName, tokenTransport });
}

export async function segfyPOST<T = unknown>(
  path: string,
  bodyData: Record<string, unknown>,
  logName?: string,
  tokenTransport: TokenTransport = 'body_corretora_token',
): Promise<SegfyResponse<T>> {
  return segfyRequest<T>({ method: 'POST', path, body: bodyData, logName, tokenTransport });
}
