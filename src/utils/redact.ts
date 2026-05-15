import 'dotenv/config';

const MASK = {
  token: '<TOKEN_MASKED>',
  bearer: '<BEARER_MASKED>',
  document: '<DOCUMENT_MASKED>',
  plate: '<PLATE_MASKED>',
  documentUrl: '<DOCUMENT_URL_MASKED>',
  pii: '<PII_MASKED>',
  secret: '<SECRET_MASKED>',
};

const SECRET_VALUES = [
  process.env.SEGFY_CLIENT_ID,
  process.env.SEGFY_CLIENT_SECRET,
  process.env.RPI_CORRETORA_TOKEN,
].filter((v): v is string => Boolean(v && v.length >= 6));

const TOKEN_QUERY_KEYS = new Set([
  'token',
  'corretora_token',
  'access_token',
  'client_id',
  'client_secret',
  'secret',
  'password',
  'senha',
]);

function maskForKey(key: string, path: string[] = []): string | null {
  const normalized = key.toLowerCase();
  const fullPath = path.join('.').toLowerCase();
  if (normalized === 'token_type') return null;
  if (
    normalized === 'authorization' ||
    normalized === 'bearer' ||
    normalized === 'token' ||
    normalized.endsWith('_token') ||
    normalized.includes('corretora_token')
  ) {
    return MASK.token;
  }
  if (normalized.includes('secret') || normalized.includes('password') || normalized.includes('senha')) {
    return MASK.secret;
  }
  if (
    normalized === 'cpf' ||
    normalized === 'cnpj' ||
    normalized === 'document' ||
    normalized.includes('documento') ||
    normalized === 'cpf_cnpj' ||
    normalized === 'habilitacao' ||
    normalized.includes('chassi')
  ) {
    return MASK.document;
  }
  if (normalized === 'placa') return MASK.plate;
  if (
    normalized === 'nome' ||
    normalized === 'social_name' ||
    (normalized === 'name' && /(customer|driver|insured|person)/.test(fullPath)) ||
    normalized === 'email' ||
    normalized === 'cellphone' ||
    normalized === 'phone' ||
    normalized.includes('telefone') ||
    normalized === 'celular' ||
    normalized.includes('nascimento') ||
    normalized.includes('birth_date')
  ) {
    return MASK.pii;
  }
  return null;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (TOKEN_QUERY_KEYS.has(key.toLowerCase()) || maskForKey(key, [key])) {
        url.searchParams.set(key, MASK.token);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactString(value: string, extraSecrets: string[] = []): string {
  let out = redactUrl(value);
  for (const secret of [...SECRET_VALUES, ...extraSecrets].filter((v) => v.length >= 6)) {
    out = out.split(secret).join(secret.startsWith('Bearer ') ? MASK.bearer : MASK.token);
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK.bearer}`);
  out = out.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, MASK.document);
  out = out.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, MASK.document);
  out = out.replace(/\b[A-Z]{3}[-\s]?\d[A-Z0-9]\d{2}\b/gi, MASK.plate);
  out = out.replace(/https?:\/\/\S*pdf-cotacoes\/\S+/gi, MASK.documentUrl);
  return out;
}

export function redactDeep<T>(value: T, extraSecrets: string[] = [], path: string[] = []): T {
  if (typeof value === 'string') {
    return redactString(value, extraSecrets) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, extraSecrets, path)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = [...path, key];
      const mask = maskForKey(key, nextPath);
      out[key] = mask ?? redactDeep(nested, extraSecrets, nextPath);
    }
    return out as T;
  }
  return value;
}

export function safeLogName(name: string): string {
  return redactString(name)
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'log';
}
