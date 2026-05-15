import { segfyRequest, type SegfyResponse, type TokenTransport } from './client.js';

interface TokenProbe {
  label: string;
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: Record<string, unknown>;
  tokenTransport: TokenTransport;
}

export interface TokenProbeResult {
  label: string;
  method: 'GET' | 'POST';
  path: string;
  transport: TokenTransport;
  ok: boolean;
  status: number;
  timeMs: number;
  messages?: unknown;
  bodyShape: string;
}

const PROBES: TokenProbe[] = [
  {
    label: 'brand-list via body config.token + data',
    method: 'POST',
    path: '/api/vehicle/version/1.0/brand-list',
    body: { data: {} },
    tokenTransport: 'body_config_token',
  },
  {
    label: 'model-list via body config.token + data',
    method: 'POST',
    path: '/api/vehicle/version/1.0/model-list',
    body: {
      data: {
        brand_id: 'f82fa6bd-b20e-4aca-89d3-e4267e9c9e70',
        vehicle_type: 'car',
        model_year: 2020,
      },
    },
    tokenTransport: 'body_config_token',
  },
  {
    label: 'profession-list via body config.token + data',
    method: 'POST',
    path: '/api/vehicle/version/1.0/profession-list',
    body: { data: {} },
    tokenTransport: 'body_config_token',
  },
  {
    label: 'renewal-list via body config.token + data',
    method: 'POST',
    path: '/api/vehicle/version/1.0/renewal-list',
    body: { data: {} },
    tokenTransport: 'body_config_token',
  },
  {
    label: 'controle negativo: brand-list via query corretora_token',
    method: 'GET',
    path: '/api/vehicle/version/1.0/brand-list',
    query: { tipo: 'carro' },
    tokenTransport: 'query_corretora_token',
  },
];

function bodyShape(body: unknown): string {
  if (Array.isArray(body)) return `array(${body.length})`;
  if (body && typeof body === 'object') {
    return `object(${Object.keys(body as Record<string, unknown>).slice(0, 8).join(',')})`;
  }
  return typeof body;
}

function responseMessages(response: SegfyResponse): unknown {
  if (response.body && typeof response.body === 'object') {
    const body = response.body as Record<string, unknown>;
    return body.messages ?? body.message ?? body.error ?? body.status;
  }
  return undefined;
}

export async function runTokenTransportDiagnostic(): Promise<TokenProbeResult[]> {
  const results: TokenProbeResult[] = [];
  for (const probe of PROBES) {
    const response = await segfyRequest({
      method: probe.method,
      path: probe.path,
      query: probe.query,
      body: probe.body,
      tokenTransport: probe.tokenTransport,
      logName: `diagnostico_token_${probe.tokenTransport}`,
    });
    results.push({
      label: probe.label,
      method: probe.method,
      path: probe.path,
      transport: probe.tokenTransport,
      ok: response.ok,
      status: response.status,
      timeMs: response.timeMs,
      messages: responseMessages(response),
      bodyShape: bodyShape(response.body),
    });
  }
  return results;
}
