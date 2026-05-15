import { Hono } from 'hono';
import { getQuoteSummary, type QuoteCustomerInfo, type CoveragePreference } from '../quote/summary.js';
import { autoF1QuoteRequestSchema, runAutoF1Quote } from '../journey/autoF1.js';
import { handleAutoF1AssistantMessage, parseAssistantRequest } from '../assistant/autoF1.js';
import { parseRagSearchRequest, searchKnowledge } from '../assistant/rag.js';

export const api = new Hono();

// Cache em memória do contexto do lead por GUID — sobrevive entre runAutoF1Quote e getQuoteSummary.
// Suficiente pro spike; quando F4 entrar com Postgres, vira tabela `quote_meta`.
const QUOTE_CUSTOMER_CACHE = new Map<string, { info: QuoteCustomerInfo; expiresAt: number }>();
const QUOTE_CUSTOMER_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function cacheCustomerForGuid(guid: string, info: QuoteCustomerInfo): void {
  QUOTE_CUSTOMER_CACHE.set(guid, { info, expiresAt: Date.now() + QUOTE_CUSTOMER_TTL_MS });
}

function readCustomerForGuid(guid: string): QuoteCustomerInfo | undefined {
  const entry = QUOTE_CUSTOMER_CACHE.get(guid);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    QUOTE_CUSTOMER_CACHE.delete(guid);
    return undefined;
  }
  return entry.info;
}

function normalizeCoveragePreference(value: string | undefined): CoveragePreference {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('economia')) return 'Economia';
  if (normalized.includes('equilib') || normalized.includes('equilíb')) return 'Equilíbrio';
  if (normalized.includes('prote') || normalized.includes('protec')) return 'Proteção';
  return null;
}

api.get('/jornadas/auto/f1', (c) =>
  c.json({
    ok: true,
    id: 'robocote-auto-f1',
    version: '2026-05-14-v3',
    mode: 'deterministic',
    quoteRoomPath: '/quote-room',
    policy: {
      cpf: 'coletar somente no fim do fluxo, antes de proposta/cálculo real',
      secrets: 'nunca expor token, bearer, CPF, placa, chassi ou payload bruto da Segfy no frontend',
      ai: 'IA futura deve operar os estados desta jornada, não substituir o contrato determinístico',
    },
    steps: [
      { id: 'name', label: 'Nome', type: 'text', required: true, prompt: 'Qual é seu nome completo?' },
      {
        id: 'vehicle_brand',
        label: 'Marca',
        type: 'choice',
        required: true,
        prompt: 'Qual a marca do veículo?',
        options: ['Honda', 'Toyota', 'Volkswagen', 'Fiat', 'Chevrolet', 'Hyundai', 'Outra'],
      },
      {
        id: 'vehicle_year',
        label: 'Ano',
        type: 'text',
        required: true,
        prompt: 'Qual o ano do veículo?',
      },
      {
        id: 'vehicle_model',
        label: 'Modelo',
        type: 'text',
        required: true,
        prompt: 'Qual o modelo do veículo?',
      },
      {
        id: 'usage',
        label: 'Uso',
        type: 'choice',
        required: true,
        prompt: 'Qual uso principal do veículo?',
        options: ['Uso pessoal', 'Trabalho/visitas', 'Empresa/frota'],
      },
      {
        id: 'renewal_status',
        label: 'Renovação',
        type: 'choice',
        required: true,
        prompt: 'É seguro novo ou renovação?',
        options: ['new', 'renewal'],
      },
      {
        id: 'zip_code',
        label: 'CEP',
        type: 'text',
        required: true,
        prompt: 'Qual o CEP de residência?',
      },
      {
        id: 'residence_type',
        label: 'Residência',
        type: 'choice',
        required: true,
        prompt: 'Casa ou apartamento?',
        options: ['house', 'apartment'],
      },
      {
        id: 'residence_garage',
        label: 'Garagem',
        type: 'choice',
        required: true,
        prompt: 'Tem garagem na residência?',
        options: ['yes_with_electronic_gate', 'yes_no_electronic_gate', 'no_garage'],
      },
      {
        id: 'marital_status',
        label: 'Estado civil',
        type: 'choice',
        required: true,
        prompt: 'Qual o estado civil?',
        options: ['single', 'married', 'divorced', 'widowed'],
      },
      {
        id: 'coverage',
        label: 'Perfil',
        type: 'choice',
        required: true,
        prompt: 'Economia, equilíbrio ou proteção? (afeta só o tom consultivo)',
        options: ['Economia', 'Equilíbrio', 'Proteção'],
      },
      {
        id: 'contact',
        label: 'Contato',
        type: 'text',
        required: false,
        prompt: 'Qual WhatsApp para o corretor continuar? (opcional)',
      },
      { id: 'driver_birth_date', label: 'Nascimento', type: 'text', required: true, prompt: 'Data de nascimento do condutor?' },
      { id: 'driver_sex', label: 'Sexo', type: 'choice', required: true, prompt: 'Sexo do condutor?', options: ['male', 'female'] },
      { id: 'document', label: 'CPF', type: 'text', required: true, prompt: 'CPF (penúltima pergunta — entra só agora pra reduzir atrito)' },
      { id: 'quote_link', label: 'Link', type: 'action', required: true, prompt: 'Calcular com socket oficial e gerar link da cotação consultiva.' },
    ],
  }),
);

api.get('/cotacoes/:guid/resumo', async (c) => {
  const guid = c.req.param('guid').trim();
  if (!guid) {
    return c.json({ ok: false, error: 'guid da cotacao é obrigatório' }, 400);
  }

  try {
    const customer = readCustomerForGuid(guid);
    const summary = await getQuoteSummary(guid, customer);
    return c.json(summary);
  } catch (e) {
    return c.json(
      {
        ok: false,
        error: (e as Error).message,
        source: 'segfy-show-results',
        guid,
      },
      502,
    );
  }
});

api.post('/jornadas/auto/f1/cotacao', async (c) => {
  const timeoutMs = Number(c.req.query('timeoutMs') ?? '45000');
  const body = await c.req.json().catch(() => null);
  const parsed = autoF1QuoteRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: 'dados insuficientes para calcular a cotacao Auto F1',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  try {
    const result = await runAutoF1Quote(parsed.data, timeoutMs);
    const fullName = parsed.data.answers.name?.trim() ?? '';
    const firstName = fullName ? fullName.split(/\s+/)[0] : null;
    cacheCustomerForGuid(result.guid, {
      firstName,
      coveragePreference: normalizeCoveragePreference(parsed.data.answers.coverage),
    });
    return c.json(result);
  } catch (e) {
    return c.json(
      {
        ok: false,
        error: (e as Error).message,
        source: 'segfy-calculate-socket',
      },
      502,
    );
  }
});

api.post('/assistente/auto/f1/mensagem', async (c) => {
  const body = await c.req.json().catch(() => null);

  try {
    const request = parseAssistantRequest(body);
    return c.json(await handleAutoF1AssistantMessage(request));
  } catch (e) {
    return c.json(
      {
        ok: false,
        error: (e as Error).message,
        source: 'robocote-assistant',
      },
      400,
    );
  }
});

api.post('/assistente/rag/search', async (c) => {
  const body = await c.req.json().catch(() => null);

  try {
    const request = parseRagSearchRequest(body);
    return c.json(await searchKnowledge(request));
  } catch (e) {
    return c.json(
      {
        ok: false,
        error: (e as Error).message,
        source: 'robocote-rag',
      },
      400,
    );
  }
});
