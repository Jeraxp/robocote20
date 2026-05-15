import 'dotenv/config';

const BASE_URL = process.env.SEGFY_BASE_URL ?? 'https://api.automation.segfy.com';
const CLIENT_ID = process.env.SEGFY_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.SEGFY_CLIENT_SECRET ?? '';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('⚠️  SEGFY_CLIENT_ID/SECRET não definidos — auth Bearer vai falhar');
}

interface BearerCache {
  token: string;
  fetchedAt: number;
  expiresInMs: number;
}

let cache: BearerCache | null = null;

// TTL local: 23h (espelhando o padrão `app/Segfy/NovaJornada/AuthToken.php` do Robocote 1.0).
// A Segfy retorna `expires_in: 86400` (24h); cacheamos 23h pra ter 1h de margem.
const CACHE_TTL_MS = 23 * 60 * 60 * 1000;

interface AuthTokenResponse {
  token: string;
  token_type: string;
  expires_in: number;
}

export async function getBearer(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < cache.expiresInMs) {
    return cache.token;
  }

  const url = `${BASE_URL}/auths/token`;
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const start = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  const timeMs = Date.now() - start;

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth Segfy falhou (HTTP ${res.status}, ${timeMs}ms): ${text}`);
  }

  const data = (await res.json()) as AuthTokenResponse;
  cache = {
    token: data.token,
    fetchedAt: Date.now(),
    expiresInMs: CACHE_TTL_MS,
  };
  console.log(`🔑 Bearer Segfy renovado (${timeMs}ms, TTL local 23h)`);
  return cache.token;
}

export function clearBearerCache(): void {
  cache = null;
}
