/**
 * Ingestão servidor-a-servidor de leads espelhados do legado (Fase 1 da unificação).
 *
 * O observador (src/tools/legacy-mirror-poller.ts) lê o MySQL do legado e POSTa aqui.
 * Endpoint DEDICADO — não reusa /api/painel/leads/manual de propósito:
 *  - auth própria de máquina (x-robocote-ingest-secret vs ROBOCOTE_INGEST_SECRET),
 *    FECHADO por padrão: sem secret configurado, o endpoint recusa (503) — nunca "alpha aberto";
 *  - allowlist opcional de tenants (ROBOCOTE_INGEST_TENANTS) escopa o poder do secret;
 *  - idempotência por PROTOCOLO do legado (não por telefone): cada conversa do legado
 *    vira exatamente um lead no painel (chave sintética `legado:<protocolo>`), fiel ao
 *    dashboard antigo e imune à colisão "dois protocolos, mesmo telefone";
 *  - a comparação de CONTEÚDO é o critério de mudança (não o updated_at do legado —
 *    resposta nova não toca o updated_at da conversa pai; lição da revisão adversarial);
 *  - replay não polui: interação só é apendada quando o conteúdo do lead mudou;
 *  - falha de persistência (store) responde 503 no LOTE → o observador NÃO avança a
 *    marca-d'água e re-tenta; rejeição de validação é permanente e conta como processada.
 *
 * Contrato: POST /api/ingest/leads
 *   Header: x-robocote-ingest-secret: <ROBOCOTE_INGEST_SECRET>
 *   Body: { leads: [lead, ...] } ou um único lead
 *   lead: { protocolo*, tenantId*, nome?, whatsapp?, email?, veiculo?, observacoes?,
 *           origem? (default 'legado'), criadoEm? (ISO), atualizadoEm? (ISO) }
 *   Resposta 200: { ok: true, criados, atualizados, inalterados, rejeitados, resultados }
 *   Resposta 503: { ok: false, ... } quando houve erro interno de persistência — RE-TENTAR o lote.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  sessionStore,
  createInitialSessionState,
  appendSessionInteraction,
  type SessionAnswer,
  type SessionState,
} from '../session/store.js';

const INGEST_SECRET = process.env.ROBOCOTE_INGEST_SECRET?.trim() ?? '';
/** Allowlist opcional de tenants (csv). Vazio = qualquer tenant bem-formado (secret já obrigatório). */
const INGEST_TENANTS = new Set(
  (process.env.ROBOCOTE_INGEST_TENANTS ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean),
);
const MAX_BATCH = 100;
const MAX_BODY_BYTES = 512 * 1024;

if (INGEST_SECRET && !process.env.ROBOCOTE_LEAD_TTL_DAYS) {
  console.warn('[ingest] AVISO: ROBOCOTE_LEAD_TTL_DAYS não configurado — leads espelhados expiram no TTL padrão de 7 dias.');
}

export const ingest = new Hono();

// Comparação em tempo constante (mesmo padrão do secureTokenEquals do api.ts).
function secureTokenEquals(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

/**
 * Normaliza telefone BR pelo COMPRIMENTO, não pelo prefixo: número local de 10-11
 * dígitos SEMPRE ganha o país — senão DDD 55 (Santa Maria/RS) é confundido com +55
 * e o número fica truncado (achado da revisão adversarial; bug herdado do manual).
 */
function normalizePhone(value: unknown): string {
  if (typeof value !== 'string') return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits;
  return '';
}

function normalizeEmailValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email.slice(0, 180);
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function answerOf(id: string, label: string, value: string): SessionAnswer {
  return { id, label, value, rawValue: value };
}

function firstNameFrom(value: string): string | null {
  const first = value.trim().split(/\s+/)[0] ?? '';
  return first ? first : null;
}

interface IngestOutcome {
  protocolo: string;
  resultado: 'criado' | 'atualizado' | 'inalterado' | 'rejeitado' | 'erro_interno';
  motivo?: string;
}

/** Campos cuja mudança de valor conta como "conteúdo novo" (gera interação no painel). */
const CONTENT_ANSWER_IDS = ['name', 'contact', 'email', 'vehicle_hint', 'notes'] as const;

function contentSignature(answers: Record<string, SessionAnswer>): string {
  // JSON.stringify: separador ambíguo (' ') permitiria colisão entre campos adjacentes.
  return JSON.stringify(CONTENT_ANSWER_IDS.map((id) => answers[id]?.value ?? ''));
}

async function ingestOne(raw: unknown): Promise<IngestOutcome> {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const protocolo = cleanText(record.protocolo, 64);
  const tenantId = cleanText(record.tenantId, 40).toLowerCase();

  if (!protocolo) return { protocolo: '', resultado: 'rejeitado', motivo: 'protocolo é obrigatório' };
  if (!tenantId || !/^[a-z0-9_-]+$/.test(tenantId)) {
    return { protocolo, resultado: 'rejeitado', motivo: 'tenantId é obrigatório (a-z, 0-9, _ ou -)' };
  }
  if (INGEST_TENANTS.size > 0 && !INGEST_TENANTS.has(tenantId)) {
    return { protocolo, resultado: 'rejeitado', motivo: 'tenant fora do piloto de ingestão' };
  }

  const nome = cleanText(record.nome, 120);
  const whatsapp = normalizePhone(record.whatsapp);
  const email = normalizeEmailValue(record.email);
  const veiculo = cleanText(record.veiculo, 160);
  const observacoes = cleanText(record.observacoes, 600);
  const origem = cleanText(record.origem, 80) || 'legado';
  const criadoEmMs = parseIsoMs(record.criadoEm);
  const atualizadoEmMs = parseIsoMs(record.atualizadoEm);

  // Chave sintética 1:1 com a conversa do legado — canal webchat (origem real do lead).
  const key = { tenantId, channel: 'webchat' as const, channelUserId: `legado:${protocolo}` };
  const existing = await sessionStore.get(key);

  const base = existing ?? createInitialSessionState(key);
  const answers: Record<string, SessionAnswer> = {
    ...base.answers,
    protocolo: answerOf('protocolo', 'Protocolo', protocolo),
    source: answerOf('source', 'Origem', origem),
  };
  if (nome) answers.name = answerOf('name', 'Nome', nome);
  if (whatsapp) answers.contact = answerOf('contact', 'Contato', whatsapp);
  if (email) answers.email = answerOf('email', 'E-mail', email);
  if (veiculo) answers.vehicle_hint = answerOf('vehicle_hint', 'Veículo informado', veiculo);
  if (observacoes) answers.notes = answerOf('notes', 'Observações', observacoes);
  if (atualizadoEmMs !== null) {
    answers.legado_atualizado_em = {
      id: 'legado_atualizado_em',
      label: 'Atualizado no legado',
      value: new Date(atualizadoEmMs).toISOString(),
      rawValue: String(atualizadoEmMs),
    };
  }

  // CONTEÚDO é o critério de mudança. O updated_at do legado NÃO serve de gate:
  // resposta nova (whatsapp preenchido depois) não toca o updated_at da conversa pai.
  const contentChanged = !existing || contentSignature(existing.answers) !== contentSignature(answers);
  const prevMs = existing ? Number(existing.answers.legado_atualizado_em?.rawValue ?? 0) : 0;
  const tsAdvanced = atualizadoEmMs !== null && atualizadoEmMs > prevMs;

  // Nada mudou e nada novo a persistir → não escreve (menos exposição à corrida com o Kanban).
  if (existing && !contentChanged && !tsAdvanced) {
    return { protocolo, resultado: 'inalterado' };
  }

  let nextState: SessionState = {
    ...base,
    answers,
    customerFirstName: nome ? firstNameFrom(nome) : base.customerFirstName,
    stepId: base.completed ? base.stepId : 'vehicle_brand',
    // Lead novo preserva o nascimento REAL no legado (não o instante do espelho).
    createdAt: existing ? base.createdAt : (criadoEmMs ?? base.createdAt),
  };

  if (contentChanged) {
    nextState = appendSessionInteraction(nextState, {
      direction: 'system',
      text: existing ? 'Lead do legado atualizado pelo espelho.' : 'Lead espelhado do legado.',
      action: existing ? 'ingest_legado_update' : 'ingest_legado',
      stepId: nextState.stepId,
    });
  }

  await sessionStore.upsert(nextState);
  if (!existing) return { protocolo, resultado: 'criado' };
  return { protocolo, resultado: contentChanged ? 'atualizado' : 'inalterado' };
}

ingest.post('/leads', bodyLimit({ maxSize: MAX_BODY_BYTES }), async (c) => {
  // Fechado por padrão: sem secret configurado no ambiente, ingestão não existe.
  if (!INGEST_SECRET) {
    return c.json({ ok: false, error: 'ingestão desabilitada (secret não configurado)' }, 503);
  }
  const given = c.req.header('x-robocote-ingest-secret')?.trim() ?? '';
  if (!given || !secureTokenEquals(given, INGEST_SECRET)) {
    return c.json({ ok: false, error: 'segredo de ingestão inválido' }, 401);
  }

  const body = await c.req.json().catch(() => null) as { leads?: unknown[] } | Record<string, unknown> | null;
  const list: unknown[] = Array.isArray((body as { leads?: unknown[] } | null)?.leads)
    ? (body as { leads: unknown[] }).leads
    : body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length > 0
      ? [body]
      : [];

  if (list.length === 0) {
    return c.json({ ok: false, error: 'body vazio — envie um lead ou { leads: [...] }' }, 400);
  }
  if (list.length > MAX_BATCH) {
    return c.json({ ok: false, error: `máximo de ${MAX_BATCH} leads por chamada` }, 400);
  }

  const resultados: IngestOutcome[] = [];
  for (const item of list) {
    try {
      resultados.push(await ingestOne(item));
    } catch (e) {
      // Erro de persistência é TRANSITÓRIO: não vaza detalhe pro chamador, loga no servidor,
      // e o lote inteiro responde 503 pra marca-d'água do observador não avançar.
      const protocolo = cleanText((item as Record<string, unknown> | null)?.protocolo, 64);
      console.error(`[ingest] erro interno ao gravar lead protocolo=${protocolo}: ${(e as Error).message}`);
      resultados.push({ protocolo, resultado: 'erro_interno', motivo: 'erro interno ao gravar lead' });
    }
  }

  const tally = {
    criados: resultados.filter((r) => r.resultado === 'criado').length,
    atualizados: resultados.filter((r) => r.resultado === 'atualizado').length,
    inalterados: resultados.filter((r) => r.resultado === 'inalterado').length,
    rejeitados: resultados.filter((r) => r.resultado === 'rejeitado').length,
    erros_internos: resultados.filter((r) => r.resultado === 'erro_interno').length,
  };

  // Rastro de auditoria por lote (doutrina: rastro de tudo).
  const porTenant = new Map<string, number>();
  for (const item of list) {
    const t = cleanText((item as Record<string, unknown> | null)?.tenantId, 40).toLowerCase() || '?';
    porTenant.set(t, (porTenant.get(t) ?? 0) + 1);
  }
  console.log(`[ingest] lote ${list.length} leads (${[...porTenant.entries()].map(([t, n]) => `${t}:${n}`).join(', ')}): ` +
    `+${tally.criados} ~${tally.atualizados} =${tally.inalterados} x${tally.rejeitados} !${tally.erros_internos}`);

  if (tally.erros_internos > 0) {
    return c.json({ ok: false, error: 'falha de persistência — re-tente o lote', ...tally, resultados }, 503);
  }
  return c.json({ ok: true, ...tally, resultados });
});

/** Saúde da porta de ingestão — não expõe o secret, só se está armado. */
ingest.get('/health', (c) => {
  return c.json({
    ok: true,
    ingestConfigured: Boolean(INGEST_SECRET),
    tenantAllowlist: INGEST_TENANTS.size > 0 ? [...INGEST_TENANTS] : null,
    maxBatch: MAX_BATCH,
  });
});
