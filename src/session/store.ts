/**
 * SessionStore — estado conversacional por lead.
 *
 * No webchat, o frontend React mantém o estado e envia snapshot a cada turno.
 * No WhatsApp não tem frontend — o backend precisa lembrar quem é o lead, em
 * que step está, que pistas ele já deu, qual é o nome dele.
 *
 * Implementação atual: in-memory com TTL. Sobrevive ao tempo de vida do processo.
 * Backend reiniciar = sessões em andamento perdidas. Aceitável pra alpha de
 * validação no WhatsApp; pra produção, troca pra Postgres mantendo a interface.
 */

import type { CoveragePreference } from '../quote/summary.js';
import { getPostgresPool, isPostgresConfigured } from '../db/postgres.js';

export type SessionChannel = 'webchat' | 'whatsapp';
export type PipelineStage = 'novos_leads' | 'contatados' | 'em_negociacao' | 'sem_retorno' | 'vendas' | 'perdido';

const ACTIVE_STEPS = [
  'name',
  'vehicle_plate',
  'vehicle_brand',
  'vehicle_year',
  'vehicle_model',
  'usage',
  'renewal_status',
  'zip_code',
  'residence_type',
  'residence_garage',
  'marital_status',
  // Questionário de risco — responsabilidade do segurado (Jera 2026-05-17).
  'is_main_driver',
  'main_driver_document',
  'young_driver',
  'studies',
  'study_garage',
  'work_commute',
  'work_garage',
  'monthly_km',
  'coverage',
  'contact',
  // driver_birth_date + driver_sex eliminados — vêm via lookup /insured do CPF
  'document',
  'driver_birth_date',
  'driver_sex',
  'quote_link',
] as const;
export type SessionStepId = (typeof ACTIVE_STEPS)[number] | 'complete';

export interface SessionAnswer {
  id: string;
  label: string;
  value: string;
  rawValue?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Proposta pendente — Robocotesugeriu um valor (geralmente usando pista anterior)
 * e está esperando "sim"/"não" do lead pra cravar e avançar o step.
 */
export interface PendingProposal {
  stepId: string;
  value: string;
  displayLabel?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Confirmação pendente de placa que decode-plate não encontrou.
 * Permite o fluxo: "esta placa não retornou, está correta?" → confirma → manual,
 * ou nova placa → tenta de novo. `finalOffer=true` quando já houve 2+ tentativas
 * sem sucesso — próximo "sim" cai direto pra fallback manual.
 */
export interface PendingPlateConfirmation {
  plate: string;
  attempts: number;
  finalOffer: boolean;
}

export interface SessionInteraction {
  id: string;
  at: number;
  direction: 'inbound' | 'outbound' | 'system';
  text: string;
  action?: string;
  stepId?: SessionStepId;
  quoteGuid?: string | null;
}

export interface SessionState {
  tenantId: string;
  channel: SessionChannel;
  channelUserId: string;

  stepId: SessionStepId;
  completed: boolean;
  pipelineStage: PipelineStage;
  answers: Record<string, SessionAnswer>;
  recentMessages: string[];
  interactions: SessionInteraction[];

  customerFirstName: string | null;
  coveragePreference: CoveragePreference;

  /** Proposta aguardando confirmação explícita do lead (sim/não). */
  pendingProposal: PendingProposal | null;

  /** Placa que falhou decode aguardando confirmação ou correção pelo lead. */
  pendingPlateConfirmation: PendingPlateConfirmation | null;

  lastGuid: string | null;
  /** Timestamp do último calculate disparado — usado pra idempotência (lock 60s). */
  lastCalculateAt: number | null;

  createdAt: number;
  updatedAt: number;
}

export interface SessionKey {
  tenantId: string;
  channel: SessionChannel;
  channelUserId: string;
}

export interface SessionStore {
  get(key: SessionKey): Promise<SessionState | null>;
  list(filter?: { tenantId?: string }): Promise<SessionState[]>;
  upsert(state: SessionState): Promise<SessionState>;
  delete(key: SessionKey): Promise<void>;
  size(): Promise<number>;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function keyOf({ tenantId, channel, channelUserId }: SessionKey): string {
  return `${tenantId}::${channel}::${channelUserId}`;
}

export function createInitialSessionState(key: SessionKey): SessionState {
  const now = Date.now();
  return {
    tenantId: key.tenantId,
    channel: key.channel,
    channelUserId: key.channelUserId,
    stepId: 'name',
    completed: false,
    pipelineStage: 'novos_leads',
    answers: {},
    recentMessages: [],
    interactions: [],
    customerFirstName: null,
    coveragePreference: null,
    pendingProposal: null,
    pendingPlateConfirmation: null,
    lastGuid: null,
    lastCalculateAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export class InMemorySessionStore implements SessionStore {
  private store = new Map<string, { state: SessionState; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  async get(key: SessionKey): Promise<SessionState | null> {
    const entry = this.store.get(keyOf(key));
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(keyOf(key));
      return null;
    }
    return entry.state;
  }

  async list(filter: { tenantId?: string } = {}): Promise<SessionState[]> {
    this.cleanupExpired();
    return [...this.store.values()]
      .map((entry) => entry.state)
      .filter((state) => !filter.tenantId || state.tenantId === filter.tenantId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async upsert(state: SessionState): Promise<SessionState> {
    const now = Date.now();
    const next: SessionState = {
      ...state,
      pipelineStage: state.pipelineStage ?? 'novos_leads',
      interactions: state.interactions ?? [],
      updatedAt: now,
    };
    this.store.set(keyOf(next), { state: next, expiresAt: now + this.ttlMs });
    return next;
  }

  async delete(key: SessionKey): Promise<void> {
    this.store.delete(keyOf(key));
  }

  async size(): Promise<number> {
    this.cleanupExpired();
    return this.store.size;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [k, entry] of this.store.entries()) {
      if (entry.expiresAt < now) this.store.delete(k);
    }
  }
}

export class PostgresSessionStore implements SessionStore {
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  async get(key: SessionKey): Promise<SessionState | null> {
    const result = await getPostgresPool().query(
      `select state from lead_sessions
       where tenant_id = $1 and channel = $2 and channel_user_id = $3 and expires_at > now()
       limit 1`,
      [key.tenantId, key.channel, key.channelUserId],
    );
    const state = result.rows[0]?.state as SessionState | undefined;
    return state ?? null;
  }

  async list(filter: { tenantId?: string } = {}): Promise<SessionState[]> {
    const pool = getPostgresPool();
    const result = filter.tenantId
      ? await pool.query(
          `select state from lead_sessions
           where tenant_id = $1 and expires_at > now()
           order by updated_at desc`,
          [filter.tenantId],
        )
      : await pool.query(
          `select state from lead_sessions
           where expires_at > now()
           order by updated_at desc`,
        );

    return result.rows.map((row) => row.state as SessionState);
  }

  async upsert(state: SessionState): Promise<SessionState> {
    const now = Date.now();
    const next: SessionState = {
      ...state,
      pipelineStage: state.pipelineStage ?? 'novos_leads',
      interactions: state.interactions ?? [],
      updatedAt: now,
    };
    const expiresAt = new Date(now + this.ttlMs);

    await getPostgresPool().query(
      `insert into lead_sessions (tenant_id, channel, channel_user_id, state, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7)
       on conflict (tenant_id, channel, channel_user_id)
       do update set state = excluded.state, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      [
        next.tenantId,
        next.channel,
        next.channelUserId,
        JSON.stringify(next),
        expiresAt,
        new Date(next.createdAt),
        new Date(next.updatedAt),
      ],
    );

    return next;
  }

  async delete(key: SessionKey): Promise<void> {
    await getPostgresPool().query(
      'delete from lead_sessions where tenant_id = $1 and channel = $2 and channel_user_id = $3',
      [key.tenantId, key.channel, key.channelUserId],
    );
  }

  async size(): Promise<number> {
    const result = await getPostgresPool().query('select count(*)::int as total from lead_sessions where expires_at > now()');
    return Number(result.rows[0]?.total ?? 0);
  }
}

export function appendSessionInteraction(
  state: SessionState,
  interaction: Omit<SessionInteraction, 'id' | 'at'> & { id?: string; at?: number },
): SessionState {
  const at = interaction.at ?? Date.now();
  const id = interaction.id ?? `${at}-${Math.random().toString(16).slice(2)}`;
  const next: SessionInteraction = {
    id,
    at,
    direction: interaction.direction,
    text: interaction.text,
    action: interaction.action,
    stepId: interaction.stepId,
    quoteGuid: interaction.quoteGuid,
  };

  return {
    ...state,
    interactions: [...(state.interactions ?? []), next].slice(-200),
  };
}

// Instância singleton compartilhada. Sem DATABASE_URL, o spike continua in-memory.
export const sessionStore: SessionStore = isPostgresConfigured()
  ? new PostgresSessionStore()
  : new InMemorySessionStore();
