import { z } from 'zod';

const AI_BASE_URL = process.env.TASKDUN_AI_BASE_URL?.trim() ?? '';
const AI_API_KEY = process.env.TASKDUN_AI_API_KEY?.trim() ?? '';
const VECTOR_STORE_ID = process.env.ROBOCOTE_VECTOR_STORE_ID?.trim() ?? '';
const RAG_MAX_RESULTS = Number(process.env.ROBOCOTE_RAG_MAX_RESULTS ?? '5');
const EMBEDDING_MODEL = process.env.ROBOCOTE_EMBEDDING_MODEL?.trim() || 'text-embedding-3-large';

const ragSearchRequestSchema = z.object({
  query: z.string().trim().min(2).max(800),
  maxResults: z.number().int().min(1).max(10).optional(),
});

export type RagSearchRequest = z.infer<typeof ragSearchRequestSchema>;

export interface RagSearchResult {
  score?: number;
  text: string;
  fileId?: string;
  filename?: string;
  attributes?: Record<string, unknown>;
}

export interface RagSearchResponse {
  ok: true;
  configured: boolean;
  vectorStoreId: string;
  query: string;
  results: RagSearchResult[];
}

function configured(): boolean {
  return Boolean(AI_BASE_URL && AI_API_KEY && VECTOR_STORE_ID);
}

function maxResults(requested?: number): number {
  if (requested) return requested;
  if (Number.isInteger(RAG_MAX_RESULTS) && RAG_MAX_RESULTS >= 1 && RAG_MAX_RESULTS <= 10) return RAG_MAX_RESULTS;
  return 5;
}

function hasSensitiveIdentifier(value: string): boolean {
  return /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(value) ||
    /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/.test(value) ||
    /\b(?:\+?55\s*)?\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/.test(value);
}

function searchUrl(): string {
  return new URL(`/v1/vector_stores/${encodeURIComponent(VECTOR_STORE_ID)}/search`, AI_BASE_URL).toString();
}

function contentToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeResult(value: unknown): RagSearchResult | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const text = contentToText(item.content) || contentToText(item.text) || contentToText(item.chunk);
  if (!text.trim()) return null;

  return {
    score: typeof item.score === 'number' ? item.score : undefined,
    text: text.trim().slice(0, 1800),
    fileId: typeof item.file_id === 'string' ? item.file_id : undefined,
    filename: typeof item.filename === 'string' ? item.filename : undefined,
    attributes: item.attributes && typeof item.attributes === 'object'
      ? item.attributes as Record<string, unknown>
      : undefined,
  };
}

export function parseRagSearchRequest(value: unknown): RagSearchRequest {
  return ragSearchRequestSchema.parse(value);
}

export function getRagConfig(): {
  configured: boolean;
  vectorStoreConfigured: boolean;
  embeddingModel: string;
  maxResults: number;
} {
  return {
    configured: configured(),
    vectorStoreConfigured: Boolean(VECTOR_STORE_ID),
    embeddingModel: EMBEDDING_MODEL,
    maxResults: maxResults(),
  };
}

export async function searchKnowledge(request: RagSearchRequest): Promise<RagSearchResponse> {
  if (!configured()) {
    throw new Error('base RAG ainda não configurada');
  }
  if (hasSensitiveIdentifier(request.query)) {
    throw new Error('consulta RAG não deve receber CPF, CNPJ ou telefone');
  }

  const response = await fetch(searchUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: request.query,
      max_num_results: maxResults(request.maxResults),
      rewrite_query: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`vector store search HTTP ${response.status}`);
  }

  const body = await response.json() as { data?: unknown[] };
  const results = (body.data ?? [])
    .map(normalizeResult)
    .filter((item): item is RagSearchResult => Boolean(item));

  return {
    ok: true,
    configured: true,
    vectorStoreId: VECTOR_STORE_ID,
    query: request.query,
    results,
  };
}
