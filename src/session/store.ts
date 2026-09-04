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
/**
 * `historico`: acervo espelhado do legado — lead antigo demais pra afirmar em que
 * pé está. Não é "sem retorno" (isso afirmaria que houve tentativa sem resposta);
 * é honestidade sobre o que não sabemos. Fica fora do funil ativo.
 */
export type PipelineStage = 'novos_leads' | 'contatados' | 'em_negociacao' | 'sem_retorno' | 'vendas' | 'perdido' | 'historico';

const ACTIVE_STEPS = [
  'name',
  'vehicle_plate',
  'vehicle_brand',
  'vehicle_year',
  'vehicle_model',
  'usage',
  'renewal_status',
  'renewal_bonus',
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
  // Residencial (ordem em core/conversation/steps.ts RESIDENCIAL_STEP_ORDER).
  'res_zip',
  'res_street',
  'res_neighborhood',
  'res_city',
  'res_state',
  'res_number',
  'res_complement',
  'res_segment',
  'res_construction',
  'res_residence_type',
  'res_building_value',
  'res_content_value',
  'res_condominium',
  'res_alarm',
  'res_grills',
  'res_countryside',
  'res_owner',
  'res_new',
] as const;
/**
 * Steps de intake (roteamento) que antecedem a jornada de captura (Jera 2026-05-31):
 *  - service_type: "Você precisa de uma cotação ou de atendimento?"
 *  - branch_select: "Para qual seguro você deseja essa cotação?" (ramos ativos)
 * São tratados deterministicamente no orquestrador, antes da jornada Segfy.
 */
export type IntakeStepId = 'service_type' | 'branch_select';
export type SessionStepId = IntakeStepId | (typeof ACTIVE_STEPS)[number] | 'complete';

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

/**
 * Estado de intervenção humana — quando operador da corretora assume conversa
 * (via WhatsApp Web ou comando explícito no painel). Enquanto `active=true`,
 * o agente IA NÃO responde nada — só registra mensagens do lead no histórico.
 *
 * Retomada automática: depois de 24h sem mensagem outbound do humano, o bot
 * volta com mensagem de recapitulação.
 *
 * Retomada manual: operador clica "Devolver pro Bot" no painel.
 */
export interface HumanOverride {
  active: boolean;
  startedAt: number;
  /** Timestamp da última mensagem outbound do humano (usado pra timeout 24h). */
  lastActivityAt: number;
  /**
   * Origem: 'auto_detected' (outbound não-bot) | 'panel_explicit' (botão no painel)
   * | 'lead_requested' (lead escolheu "Atendimento" no intake — Jera 2026-05-31).
   */
  source: 'auto_detected' | 'panel_explicit' | 'lead_requested';
  /** Quando preenchido, identifica qual operador assumiu (panel_explicit). */
  operatorId?: string;
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

  /** Operador humano assumiu conversa — bot pausa até timeout/devolução manual. */
  humanOverride: HumanOverride | null;

  lastGuid: string | null;
  /** Timestamp do último calculate disparado — usado pra idempotência (lock 60s). */
  lastCalculateAt: number | null;

  /**
   * true quando a mensagem chegou por uma conta de canal que NÃO está cadastrada
   * em `whatsapp_instances`. O lead foi atendido com o tenant padrão, mas fica a
   * marca de que o sistema não soube de quem era — detector do IROM.
   */
  tenantUnresolved?: boolean;

  createdAt: number;
  updatedAt: number;
}

export interface SessionKey {
  tenantId: string;
  channel: SessionChannel;
  channelUserId: string;
}

/**
 * Números do topo do painel. Contados sobre a base INTEIRA da corretora, nunca
 * sobre a janela carregada — o painel traz 500 leads por vez e "Leads: 500"
 * era o teto da janela se passando por total.
 *
 * O acervo do legado fica separado: são 42 mil conversas antigas que não estão
 * no funil e afogariam qualquer leitura de "quantos leads eu tenho".
 */
export interface PanelMetrics {
  /** Funil vivo — o que o Kanban mostra. Não inclui o acervo. */
  total: number;
  active: number;
  ready: number;
  quoted: number;
  waiting: number;
  /** Acervo do legado (estágio histórico), fora do funil. */
  archived: number;
}

/** Mesma precedência de leadStatus (routes/api.ts) — em um lugar só. */
export function statusDaSessao(state: SessionState): 'quoted' | 'ready' | 'waiting' | 'active' {
  if (state.completed || state.stepId === 'complete' || state.lastGuid) return 'quoted';
  if (state.stepId === 'quote_link') return 'ready';
  if (state.pendingProposal) return 'waiting';
  return 'active';
}

export interface SessionStore {
  get(key: SessionKey): Promise<SessionState | null>;
  /**
   * Leads do mais recente pro mais antigo. `limit` é OBRIGATÓRIO na prática pro
   * painel: com o espelho do legado, um tenant pode ter dezenas de milhares de
   * leads — carregar tudo estoura a memória do processo.
   */
  list(filter?: { tenantId?: string; limit?: number }): Promise<SessionState[]>;
  /** Quantos leads existem de fato (o painel mostra uma janela; isto é o total). */
  count(filter?: { tenantId?: string }): Promise<number>;
  metrics(filter?: { tenantId?: string }): Promise<PanelMetrics>;
  /**
   * Primeiro lead que satisfaz o predicado, varrendo em lotes (memória constante).
   * Existe porque o id do painel é um hash — não dá pra consultar direto no banco,
   * e carregar a base inteira pra achar um lead não escala com o legado espelhado.
   */
  findBy(
    filter: { tenantId?: string },
    predicate: (state: SessionState) => boolean,
  ): Promise<SessionState | null>;
  upsert(state: SessionState): Promise<SessionState>;
  delete(key: SessionKey): Promise<void>;
  size(): Promise<number>;
}

// TTL padrão 7 dias; ROBOCOTE_LEAD_TTL_DAYS estende (leads espelhados do legado não podem evaporar).
const TTL_DAYS_ENV = Number(process.env.ROBOCOTE_LEAD_TTL_DAYS);
const DEFAULT_TTL_MS = (Number.isFinite(TTL_DAYS_ENV) && TTL_DAYS_ENV > 0 ? TTL_DAYS_ENV : 7) * 24 * 60 * 60 * 1000;

function keyOf({ tenantId, channel, channelUserId }: SessionKey): string {
  return `${tenantId}::${channel}::${channelUserId}`;
}

export function createInitialSessionState(key: SessionKey): SessionState {
  const now = Date.now();
  return {
    tenantId: key.tenantId,
    channel: key.channel,
    channelUserId: key.channelUserId,
    stepId: 'service_type',
    completed: false,
    pipelineStage: 'novos_leads',
    answers: {},
    recentMessages: [],
    interactions: [],
    customerFirstName: null,
    coveragePreference: null,
    pendingProposal: null,
    pendingPlateConfirmation: null,
    humanOverride: null,
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

  async list(filter: { tenantId?: string; limit?: number } = {}): Promise<SessionState[]> {
    this.cleanupExpired();
    const ordered = [...this.store.values()]
      .map((entry) => entry.state)
      .filter((state) => !filter.tenantId || state.tenantId === filter.tenantId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return filter.limit && filter.limit > 0 ? ordered.slice(0, filter.limit) : ordered;
  }

  async count(filter: { tenantId?: string } = {}): Promise<number> {
    this.cleanupExpired();
    return [...this.store.values()]
      .filter((entry) => !filter.tenantId || entry.state.tenantId === filter.tenantId)
      .length;
  }

  async metrics(filter: { tenantId?: string } = {}): Promise<PanelMetrics> {
    this.cleanupExpired();
    const estados = [...this.store.values()]
      .map((e) => e.state)
      .filter((s) => !filter.tenantId || s.tenantId === filter.tenantId);
    const acervo = estados.filter((s) => s.pipelineStage === 'historico');
    const funil = estados.filter((s) => s.pipelineStage !== 'historico');
    const conta = (chave: ReturnType<typeof statusDaSessao>): number =>
      funil.filter((s) => statusDaSessao(s) === chave).length;
    return {
      total: funil.length,
      active: conta('active'),
      ready: conta('ready'),
      quoted: conta('quoted'),
      waiting: conta('waiting'),
      archived: acervo.length,
    };
  }

  async findBy(
    filter: { tenantId?: string },
    predicate: (state: SessionState) => boolean,
  ): Promise<SessionState | null> {
    this.cleanupExpired();
    for (const entry of this.store.values()) {
      if (filter.tenantId && entry.state.tenantId !== filter.tenantId) continue;
      if (predicate(entry.state)) return entry.state;
    }
    return null;
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

  async list(filter: { tenantId?: string; limit?: number } = {}): Promise<SessionState[]> {
    const pool = getPostgresPool();
    // LIMIT no banco (não em JS): com o legado espelhado são dezenas de milhares
    // de linhas jsonb — trazer tudo pro processo é o caminho curto pro OOM.
    const limit = filter.limit && filter.limit > 0 ? Math.floor(filter.limit) : null;
    const limitSql = limit ? ` limit ${limit}` : '';
    const result = filter.tenantId
      ? await pool.query(
          `select state from lead_sessions
           where tenant_id = $1 and expires_at > now()
           order by updated_at desc${limitSql}`,
          [filter.tenantId],
        )
      : await pool.query(
          `select state from lead_sessions
           where expires_at > now()
           order by updated_at desc${limitSql}`,
        );

    return result.rows.map((row) => row.state as SessionState);
  }

  async count(filter: { tenantId?: string } = {}): Promise<number> {
    const pool = getPostgresPool();
    const result = filter.tenantId
      ? await pool.query(
          'select count(*)::int as total from lead_sessions where tenant_id = $1 and expires_at > now()',
          [filter.tenantId],
        )
      : await pool.query('select count(*)::int as total from lead_sessions where expires_at > now()');
    return Number(result.rows[0]?.total ?? 0);
  }

  async metrics(filter: { tenantId?: string } = {}): Promise<PanelMetrics> {
    const pool = getPostgresPool();
    // Agregação no BANCO: contar em JS exigiria trazer dezenas de milhares de
    // jsonb pro processo — o caminho curto pro OOM que a janela existe pra evitar.
    // A precedência do status é a mesma de statusDaSessao; mudou lá, muda aqui.
    const { rows } = await pool.query(
      `select
         count(*) filter (where estagio <> 'historico')::int as total,
         count(*) filter (where estagio <> 'historico' and st = 'active')::int as active,
         count(*) filter (where estagio <> 'historico' and st = 'ready')::int as ready,
         count(*) filter (where estagio <> 'historico' and st = 'quoted')::int as quoted,
         count(*) filter (where estagio <> 'historico' and st = 'waiting')::int as waiting,
         count(*) filter (where estagio = 'historico')::int as archived
       from (
         select
           coalesce(state->>'pipelineStage', 'novos_leads') as estagio,
           case
             when coalesce((state->>'completed')::boolean, false)
               or state->>'stepId' = 'complete'
               or nullif(state->>'lastGuid', '') is not null then 'quoted'
             when state->>'stepId' = 'quote_link' then 'ready'
             when jsonb_typeof(state->'pendingProposal') = 'object' then 'waiting'
             else 'active'
           end as st
         from lead_sessions
         where expires_at > now() and ($1::text is null or tenant_id = $1)
       ) t`,
      [filter.tenantId ?? null],
    );
    const r = rows[0] ?? {};
    return {
      total: Number(r.total ?? 0),
      active: Number(r.active ?? 0),
      ready: Number(r.ready ?? 0),
      quoted: Number(r.quoted ?? 0),
      waiting: Number(r.waiting ?? 0),
      archived: Number(r.archived ?? 0),
    };
  }

  async findBy(
    filter: { tenantId?: string },
    predicate: (state: SessionState) => boolean,
  ): Promise<SessionState | null> {
    const pool = getPostgresPool();
    const batch = 500;
    let offset = 0;
    // Ordem pela PK (estável): o espelho reescreve updated_at o tempo todo, e
    // paginar por ele faria linhas pularem de página no meio da varredura.
    for (;;) {
      const result = filter.tenantId
        ? await pool.query(
            `select state from lead_sessions
             where tenant_id = $1 and expires_at > now()
             order by tenant_id, channel, channel_user_id
             limit ${batch} offset ${offset}`,
            [filter.tenantId],
          )
        : await pool.query(
            `select state from lead_sessions
             where expires_at > now()
             order by tenant_id, channel, channel_user_id
             limit ${batch} offset ${offset}`,
          );

      for (const row of result.rows) {
        const state = row.state as SessionState;
        if (predicate(state)) return state;
      }
      if (result.rows.length < batch) return null;
      offset += batch;
    }
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
