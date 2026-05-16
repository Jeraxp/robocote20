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

export type SessionChannel = 'webchat' | 'whatsapp';
export type PipelineStage = 'novos_leads' | 'contatados' | 'em_negociacao' | 'sem_retorno' | 'vendas' | 'perdido';

const ACTIVE_STEPS = [
  'name',
  'vehicle_brand',
  'vehicle_year',
  'vehicle_model',
  'usage',
  'renewal_status',
  'zip_code',
  'residence_type',
  'residence_garage',
  'marital_status',
  'coverage',
  'contact',
  'driver_birth_date',
  'driver_sex',
  'document',
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
 * Proposta pendente — Vivi sugeriu um valor (geralmente usando pista anterior)
 * e está esperando "sim"/"não" do lead pra cravar e avançar o step.
 */
export interface PendingProposal {
  stepId: string;
  value: string;
  displayLabel?: string;
  metadata?: Record<string, unknown>;
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
  list(): Promise<SessionState[]>;
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

  async list(): Promise<SessionState[]> {
    this.cleanupExpired();
    return [...this.store.values()]
      .map((entry) => entry.state)
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

// Instância singleton compartilhada. Pode ser substituída por PostgresSessionStore
// quando F4 entrar — basta trocar a atribuição abaixo.
export const sessionStore: SessionStore = new InMemorySessionStore();
