import { Hono } from 'hono';
import { z } from 'zod';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHash, timingSafeEqual } from 'crypto';
import type { Context } from 'hono';
import { adminStore } from '../admin/store.js';
import {
  canManageUsers,
  canManageWhatsapp,
  resolveAuthContext,
  tenantScope,
  writableTenantId,
} from '../auth/context.js';
import { authMiddleware } from '../auth/middleware.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  findUserForLogin,
  createSession,
  deleteSession,
  setSessionImpersonation,
  resolveSession,
  authConfigured,
  SESSION_COOKIE,
} from '../auth/session.js';
import { getPostgresPool } from '../db/postgres.js';
import { getQuoteSummary, type QuoteCustomerInfo, type CoveragePreference } from '../quote/summary.js';
import { cacheQuoteContext, readQuoteContext } from '../quote/contextCache.js';
import { getAgentName } from '../tenant/agent.js';
import {
  getTenantQuoteConfig,
  saveTenantQuoteConfig,
  type CoverageAuto,
  type TenantQuoteConfigShape,
} from '../tenant/quoteConfig.js';
import { autoF1QuoteRequestSchema, runAutoF1Quote } from '../journey/autoF1.js';
import { handleAutoF1AssistantMessage, parseAssistantRequest } from '../assistant/autoF1.js';
import { parseRagSearchRequest, searchKnowledge } from '../assistant/rag.js';
import {
  appendSessionInteraction,
  createInitialSessionState,
  sessionStore,
  type PipelineStage,
  type SessionAnswer,
  type SessionState,
} from '../session/store.js';
import {
  connectEvolutionInstance,
  createEvolutionInstance,
  getEvolutionConnectionState,
} from '../channels/whatsapp/evolution.js';

export const api = new Hono();

// Resolve sessão real (login) e injeta AuthContext antes de qualquer handler.
api.use('*', authMiddleware);

const COOKIE_SECURE = process.env.NODE_ENV === 'production';
/** Quando '1', desabilita o fallback de token de painel — só login real é aceito. */
const TOKEN_AUTH_DISABLED = process.env.ROBOCOTE_DISABLE_TOKEN_AUTH === '1';

function secureTokenEquals(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function readPanelToken(c: Context): string {
  const explicit = c.req.header('x-robocote-panel-token')?.trim();
  if (explicit) return explicit;

  const authorization = c.req.header('authorization')?.trim();
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return '';
}

function requirePanelAccess(c: Context): Response | null {
  // 1. Sessão real (login) injetada pelo authMiddleware — caminho normal.
  const auth = resolveAuthContext(c);
  if (auth.authMode === 'session') return null;

  // 2. Fallback dev/local: token de painel (a menos que explicitamente desabilitado).
  if (!TOKEN_AUTH_DISABLED) {
    const expected = process.env.ROBOCOTE_PANEL_TOKEN?.trim();
    if (!expected) return null; // sem token configurado = alpha aberto (dev local)
    const token = readPanelToken(c);
    if (token && secureTokenEquals(token, expected)) return null;
  }

  return c.json({
    ok: false,
    authRequired: true,
    error: 'acesso ao painel requer login',
  }, 401);
}

// ─── Autenticação real (login + sessão server-side) ─────────────────────────
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
}

/** Registra evento de auditoria (best-effort — não derruba o fluxo se falhar). */
async function recordAuditEvent(input: {
  tenantId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!authConfigured()) return;
  try {
    await getPostgresPool().query(
      `insert into audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [input.tenantId, input.actorUserId, input.action, input.entityType, input.entityId ?? null, JSON.stringify(input.metadata ?? {})],
    );
  } catch {
    // auditoria é best-effort; não interrompe a ação principal
  }
}

api.post('/auth/login', async (c) => {
  if (!authConfigured()) {
    return c.json({ ok: false, error: 'login indisponível (Postgres não configurado)' }, 503);
  }
  const raw = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'email e senha são obrigatórios' }, 400);
  }

  const user = await findUserForLogin(parsed.data.email);
  // Mensagem genérica pra não revelar se o email existe (anti-enumeração).
  const invalid = () => c.json({ ok: false, error: 'email ou senha inválidos' }, 401);
  if (!user) return invalid();
  const ok = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!ok) return invalid();

  const sessionId = await createSession(user.userId, {
    ip: c.req.header('x-forwarded-for') ?? undefined,
    userAgent: c.req.header('user-agent') ?? undefined,
  });
  setSessionCookie(c, sessionId);

  return c.json({
    ok: true,
    user: {
      userId: user.userId,
      name: user.name,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      mustChangePassword: user.mustChangePassword,
    },
  });
});

api.post('/auth/logout', async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await deleteSession(sessionId).catch(() => undefined);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

api.get('/auth/me', async (c) => {
  const auth = resolveAuthContext(c);
  if (auth.authMode !== 'session') {
    return c.json({ ok: false, authRequired: true, error: 'não autenticado' }, 401);
  }
  return c.json({
    ok: true,
    user: {
      userId: auth.userId,
      name: auth.name,
      email: auth.email,
      role: auth.role,
      tenantId: auth.tenantId,
      isSuperadmin: auth.isSuperadmin,
      impersonatingTenantId: auth.impersonatingTenantId ?? null,
      mustChangePassword: auth.mustChangePassword ?? false,
    },
  });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

api.post('/auth/change-password', async (c) => {
  const auth = resolveAuthContext(c);
  if (auth.authMode !== 'session') {
    return c.json({ ok: false, authRequired: true, error: 'não autenticado' }, 401);
  }
  const raw = await c.req.json().catch(() => null);
  const parsed = changePasswordSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'senha atual e nova (mín. 6 chars) obrigatórias' }, 400);
  }

  const result = await getPostgresPool().query<{ password_hash: string | null }>(
    'select password_hash from users where id = $1 limit 1',
    [auth.userId],
  );
  const ok = await verifyPassword(parsed.data.currentPassword, result.rows[0]?.password_hash);
  if (!ok) return c.json({ ok: false, error: 'senha atual incorreta' }, 401);

  const newHash = await hashPassword(parsed.data.newPassword);
  await getPostgresPool().query(
    'update users set password_hash = $1, must_change_password = false, updated_at = now() where id = $2',
    [newHash, auth.userId],
  );
  return c.json({ ok: true });
});

// ─── Impersonation: superadmin "vira" uma corretora pra dar suporte ──────────
const impersonateSchema = z.object({ tenantId: z.string().min(1) });

api.post('/auth/impersonate', async (c) => {
  const auth = resolveAuthContext(c);
  if (auth.authMode !== 'session' || !auth.isSuperadmin) {
    return c.json({ ok: false, error: 'apenas superadmin pode acessar painéis de corretoras' }, 403);
  }
  const raw = await c.req.json().catch(() => null);
  const parsed = impersonateSchema.safeParse(raw);
  if (!parsed.success) return c.json({ ok: false, error: 'tenantId obrigatório' }, 400);

  // valida que o tenant existe
  const exists = await getPostgresPool().query('select 1 from tenants where id = $1 limit 1', [parsed.data.tenantId]);
  if (exists.rowCount === 0) return c.json({ ok: false, error: 'corretora não encontrada' }, 404);

  await setSessionImpersonation(auth.sessionId ?? '', parsed.data.tenantId);
  await recordAuditEvent({
    tenantId: parsed.data.tenantId,
    actorUserId: auth.userId,
    action: 'impersonate_start',
    entityType: 'tenant',
    entityId: parsed.data.tenantId,
  });

  return c.json({ ok: true, impersonatingTenantId: parsed.data.tenantId });
});

api.post('/auth/stop-impersonate', async (c) => {
  const auth = resolveAuthContext(c);
  if (auth.authMode !== 'session') {
    return c.json({ ok: false, authRequired: true, error: 'não autenticado' }, 401);
  }
  if (auth.sessionId) await setSessionImpersonation(auth.sessionId, null);
  if (auth.impersonatingTenantId) {
    await recordAuditEvent({
      tenantId: auth.impersonatingTenantId,
      actorUserId: auth.userId,
      action: 'impersonate_stop',
      entityType: 'tenant',
      entityId: auth.impersonatingTenantId,
    });
  }
  return c.json({ ok: true });
});

// Cache movido pra src/quote/contextCache.ts (compartilhado com orchestrator WhatsApp).

function normalizeCoveragePreference(value: string | undefined): CoveragePreference {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('economia')) return 'Economia';
  if (normalized.includes('equilib') || normalized.includes('equilíb')) return 'Equilíbrio';
  if (normalized.includes('prote') || normalized.includes('protec')) return 'Proteção';
  return null;
}

const PANEL_STEP_ORDER = [
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

const PANEL_LABELS: Record<string, string> = {
  name: 'Nome',
  vehicle_brand: 'Marca',
  vehicle_year: 'Ano',
  vehicle_model: 'Modelo',
  usage: 'Uso',
  renewal_status: 'Renovação',
  zip_code: 'CEP',
  residence_type: 'Residência',
  residence_garage: 'Garagem',
  marital_status: 'Estado civil',
  coverage: 'Perfil',
  contact: 'Contato',
  source: 'Origem',
  vehicle_hint: 'Veículo informado',
  notes: 'Observações',
  driver_birth_date: 'Nascimento',
  driver_sex: 'Sexo',
  document: 'CPF',
  quote_link: 'Cotação',
};

const PIPELINE_STAGES: Array<{ key: PipelineStage; label: string }> = [
  { key: 'novos_leads', label: 'Novos Leads' },
  { key: 'contatados', label: 'Contatados' },
  { key: 'em_negociacao', label: 'Em Negociação' },
  { key: 'sem_retorno', label: 'Sem Retorno' },
  { key: 'vendas', label: 'Vendas' },
  { key: 'perdido', label: 'Perdido' },
];

function stableLeadId(session: SessionState): string {
  return createHash('sha256')
    .update(`${session.tenantId}:${session.channel}:${session.channelUserId}`)
    .digest('hex')
    .slice(0, 18);
}

function maskSensitive(value: string): string {
  return value
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '<CPF protegido>')
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '<CNPJ protegido>')
    .replace(/\b\d{5}-?\d{3}\b/g, '<CEP protegido>')
    .replace(/\b(?:\+?55\s*)?\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, '<telefone protegido>');
}

function maskChannelUser(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '<canal protegido>';
  const tail = digits.slice(-4);
  if (digits.startsWith('55') && digits.length >= 12) return `+55 ** *****-${tail}`;
  return `(**) *****-${tail}`;
}

function firstNameFrom(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeManualPhone(value: unknown): string {
  if (typeof value !== 'string') return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return '';
  return digits.startsWith('55') ? digits : `55${digits}`;
}

function normalizeDocumentType(value: unknown): 'cpf' | 'cnpj' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cpf' || normalized === 'cnpj') return normalized;
  return null;
}

function normalizeDocument(value: unknown, type: 'cpf' | 'cnpj'): string {
  if (typeof value !== 'string') return '';
  const digits = value.replace(/\D/g, '');
  const expected = type === 'cpf' ? 11 : 14;
  return digits.length === expected ? digits : '';
}

function normalizeTenantUserRole(value: unknown): 'admin' | 'operador' {
  return value === 'admin' ? 'admin' : 'operador';
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email.slice(0, 180);
}

function whatsappInstanceNameForTenant(tenantId: string): string {
  return `robocote-${tenantId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function evolutionStateToWhatsappStatus(state: string | undefined): 'connected' | 'connecting' | 'disconnected' | 'logged_out' | 'created' {
  const normalized = state?.trim().toLowerCase() ?? '';
  if (normalized.includes('connecting') || normalized.includes('pairing')) return 'connecting';
  if (normalized.includes('open') || normalized.includes('connect')) return 'connected';
  if (normalized.includes('logout') || normalized.includes('logged')) return 'logged_out';
  if (normalized.includes('close') || normalized.includes('disconnect')) return 'disconnected';
  return 'created';
}

function manualAnswer(id: string, label: string, value: string): SessionAnswer {
  return { id, label, value, rawValue: value };
}

function sanitizeAnswer(answer: SessionAnswer): { id: string; label: string; value: string } {
  const label = PANEL_LABELS[answer.id] ?? answer.label ?? answer.id;
  const raw = answer.value || answer.rawValue || '';
  const sensitive = answer.id === 'document' || answer.id === 'contact' || answer.id === 'zip_code';
  return {
    id: answer.id,
    label,
    value: sensitive ? maskSensitive(raw) : maskSensitive(raw),
  };
}

function leadProgress(session: SessionState): number {
  if (session.completed || session.stepId === 'complete') return 100;
  const index = PANEL_STEP_ORDER.indexOf(session.stepId as (typeof PANEL_STEP_ORDER)[number]);
  if (index < 0) return 0;
  const answeredSteps = PANEL_STEP_ORDER.filter((step) => Boolean(session.answers[step])).length;
  return Math.round((answeredSteps / PANEL_STEP_ORDER.length) * 100);
}

function leadStatus(session: SessionState): { key: string; label: string } {
  if (session.completed || session.stepId === 'complete') return { key: 'quoted', label: 'Cotação entregue' };
  if (session.lastGuid) return { key: 'quoted', label: 'Cotação entregue' };
  if (session.stepId === 'quote_link') return { key: 'ready', label: 'Pronto para calcular' };
  if (session.pendingProposal) return { key: 'waiting', label: 'Aguardando confirmação' };
  return { key: 'active', label: 'Em atendimento' };
}

function stageLabel(stage: PipelineStage): string {
  return PIPELINE_STAGES.find((item) => item.key === stage)?.label ?? 'Novos Leads';
}

function inferredStage(session: SessionState): PipelineStage {
  if (session.completed || session.stepId === 'complete' || session.lastGuid) {
    return 'em_negociacao';
  }
  if (session.interactions?.some((item) => item.direction === 'outbound')) {
    return 'contatados';
  }
  return 'novos_leads';
}

function commercialStage(session: SessionState): { key: PipelineStage; label: string } {
  const key = session.pipelineStage ?? inferredStage(session);
  return { key, label: stageLabel(key) };
}

function sessionVehicle(session: SessionState): string {
  const brand = session.answers.vehicle_brand?.value;
  const model = session.answers.vehicle_model?.value;
  const year = session.answers.vehicle_year?.value;
  const structured = [brand, model, year].filter(Boolean).join(' · ');
  return structured || session.answers.vehicle_hint?.value || 'Veículo em coleta';
}

function sessionDisplayName(session: SessionState): string {
  return session.answers.name?.value || session.customerFirstName || 'Lead WhatsApp';
}

function serializeLead(session: SessionState) {
  const status = leadStatus(session);
  const stage = commercialStage(session);
  const interactions = (session.interactions ?? []).map((interaction) => ({
    id: interaction.id,
    at: new Date(interaction.at).toISOString(),
    direction: interaction.direction,
    text: maskSensitive(interaction.text),
    action: interaction.action ?? null,
    stepId: interaction.stepId ?? null,
    quoteGuid: interaction.quoteGuid ?? null,
  }));
  const latestInteraction = interactions.at(-1);
  const answers = Object.values(session.answers).map(sanitizeAnswer);

  return {
    id: stableLeadId(session),
    tenantId: session.tenantId,
    channel: session.channel,
    channelUser: maskChannelUser(session.channelUserId),
    name: maskSensitive(sessionDisplayName(session)),
    firstName: session.customerFirstName,
    status,
    stage,
    stepId: session.stepId,
    stepLabel: PANEL_LABELS[session.stepId] ?? session.stepId,
    progress: leadProgress(session),
    vehicle: sessionVehicle(session),
    coveragePreference: session.coveragePreference,
    quoteGuid: session.lastGuid,
    quoteRoomPath: session.lastGuid ? `/quote-room/${session.lastGuid}` : null,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    answers,
    interactions,
    latestMessage: latestInteraction?.text ?? null,
    humanOverride: session.humanOverride?.active
      ? {
          active: true,
          source: session.humanOverride.source,
          startedAt: new Date(session.humanOverride.startedAt).toISOString(),
          lastActivityAt: new Date(session.humanOverride.lastActivityAt).toISOString(),
        }
      : null,
  };
}

function panelMetrics(leads: ReturnType<typeof serializeLead>[]) {
  return {
    total: leads.length,
    active: leads.filter((lead) => lead.status.key === 'active').length,
    ready: leads.filter((lead) => lead.status.key === 'ready').length,
    quoted: leads.filter((lead) => lead.status.key === 'quoted').length,
    waiting: leads.filter((lead) => lead.status.key === 'waiting').length,
  };
}

async function canAccessWhatsappInstance(auth: ReturnType<typeof resolveAuthContext>, instanceName: string): Promise<boolean> {
  const instances = await adminStore.listWhatsappInstances(auth, auth.isSuperadmin && !auth.tenantId ? undefined : auth.tenantId ?? undefined);
  return instances.some((item) => item.evolutionInstanceName === instanceName);
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

api.get('/admin/me', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  // Superadmin impersonando vê todos os tenants (pra poder trocar); senão escopo normal.
  const listAuth = auth.isSuperadmin ? { ...auth, tenantId: null } : auth;
  const tenants = await adminStore.listTenants(listAuth);
  return c.json({
    ok: true,
    auth,
    capabilities: {
      manageUsers: canManageUsers(auth),
      manageWhatsapp: canManageWhatsapp(auth),
      viewAllTenants: auth.isSuperadmin,
    },
    tenants,
    navigation: [
      { key: 'leads', label: 'Leads / CRM', enabled: true },
      { key: 'tenants', label: 'Corretoras', enabled: auth.isSuperadmin },
      { key: 'users', label: 'Usuários', enabled: canManageUsers(auth) },
      { key: 'whatsapp', label: 'WhatsApp', enabled: canManageWhatsapp(auth) },
      { key: 'settings', label: 'Configurações', enabled: auth.role !== 'operador' },
      { key: 'support', label: 'Suporte Robocote', enabled: auth.isSuperadmin },
    ],
  });
});

api.get('/admin/tenants', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  if (!auth.isSuperadmin) {
    return c.json({ ok: false, error: 'apenas superadmin pode listar corretoras' }, 403);
  }
  return c.json({ ok: true, tenants: await adminStore.listTenants(auth) });
});

api.post('/admin/tenants', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  if (!auth.isSuperadmin) {
    return c.json({ ok: false, error: 'apenas superadmin pode criar corretoras' }, 403);
  }

  const body = await c.req.json().catch(() => null) as {
    documentType?: string;
    document?: string;
    brokerName?: string;
    brokerPhone?: string;
    managerName?: string;
    managerEmail?: string;
    managerWhatsapp?: string;
    createWhatsapp?: boolean;
  } | null;

  const documentType = normalizeDocumentType(body?.documentType);
  if (!documentType) {
    return c.json({ ok: false, error: 'tipo de documento deve ser cpf ou cnpj' }, 400);
  }

  const document = normalizeDocument(body?.document, documentType);
  const brokerName = cleanText(body?.brokerName, 140);
  const brokerPhone = normalizeManualPhone(body?.brokerPhone);
  const managerName = cleanText(body?.managerName, 120);
  const managerEmail = normalizeEmail(body?.managerEmail);
  const managerWhatsapp = normalizeManualPhone(body?.managerWhatsapp);

  if (!document) return c.json({ ok: false, error: `${documentType.toUpperCase()} inválido` }, 400);
  if (!brokerName) return c.json({ ok: false, error: 'nome da corretora é obrigatório' }, 400);
  if (!brokerPhone) return c.json({ ok: false, error: 'telefone principal válido é obrigatório' }, 400);
  if (!managerName) return c.json({ ok: false, error: 'nome do gestor é obrigatório' }, 400);
  if (!managerEmail) return c.json({ ok: false, error: 'email do gestor válido é obrigatório' }, 400);
  if (!managerWhatsapp) return c.json({ ok: false, error: 'WhatsApp do gestor válido é obrigatório' }, 400);

  try {
    const result = await adminStore.createTenantWithManager({
      documentType,
      document,
      brokerName,
      brokerPhone,
      managerName,
      managerEmail,
      managerWhatsapp,
    });

    let whatsapp: {
      instance: Awaited<ReturnType<typeof adminStore.createWhatsappInstance>>;
      evolution: Awaited<ReturnType<typeof createEvolutionInstance>> | null;
    } | null = null;
    if (body?.createWhatsapp !== false) {
      const instanceName = whatsappInstanceNameForTenant(result.tenant.id);
      const evolution = await createEvolutionInstance({
        instanceName,
        ownerPhone: brokerPhone,
      });
      const instance = await adminStore.createWhatsappInstance({
        tenantId: result.tenant.id,
        evolutionInstanceName: instanceName,
        ownerPhone: brokerPhone,
        status: evolution.ok ? 'created' : 'error',
      });
      whatsapp = { instance, evolution };
    }

    return c.json({ ok: true, ...result, whatsapp }, 201);
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 409);
  }
});

api.get('/admin/users', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  if (!canManageUsers(auth)) {
    return c.json({ ok: false, error: 'usuário sem permissão para gerenciar usuários' }, 403);
  }
  const tenantId = c.req.query('tenantId') || auth.tenantId || undefined;
  return c.json({ ok: true, users: await adminStore.listUsers(auth, tenantId) });
});

api.post('/admin/users', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  if (!canManageUsers(auth)) {
    return c.json({ ok: false, error: 'usuário sem permissão para gerenciar usuários' }, 403);
  }

  const body = await c.req.json().catch(() => null) as {
    tenantId?: string;
    name?: string;
    email?: string;
    phone?: string;
    role?: string;
    password?: string;
  } | null;

  const tenantId = auth.isSuperadmin
    ? cleanText(body?.tenantId, 80)
    : writableTenantId(auth, body?.tenantId);
  const role = normalizeTenantUserRole(body?.role);
  const name = cleanText(body?.name, 120);
  const email = normalizeEmail(body?.email);
  const phone = typeof body?.phone === 'string' && body.phone.trim()
    ? normalizeManualPhone(body.phone)
    : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!tenantId) return c.json({ ok: false, error: 'tenant da corretora é obrigatório' }, 400);
  if (!name) return c.json({ ok: false, error: 'nome do usuário é obrigatório' }, 400);
  if (!email) return c.json({ ok: false, error: 'email válido é obrigatório' }, 400);
  if (body?.phone && !phone) return c.json({ ok: false, error: 'telefone válido é obrigatório' }, 400);
  if (!auth.isSuperadmin && role !== 'operador') {
    return c.json({ ok: false, error: 'gestor só pode cadastrar operadores' }, 403);
  }
  if (password && password.length < 6) {
    return c.json({ ok: false, error: 'senha inicial deve ter ao menos 6 caracteres' }, 400);
  }

  try {
    const passwordHash = password ? await hashPassword(password) : undefined;
    const user = await adminStore.createUser(auth, {
      tenantId,
      name,
      email,
      phone: phone || undefined,
      role,
      passwordHash,
    });
    return c.json({ ok: true, user, passwordSet: Boolean(passwordHash) }, 201);
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 409);
  }
});

api.get('/admin/whatsapp-instances', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  if (!canManageWhatsapp(auth)) {
    return c.json({ ok: false, error: 'usuário sem permissão para gerenciar WhatsApp' }, 403);
  }
  const tenantId = c.req.query('tenantId') || auth.tenantId || undefined;
  return c.json({ ok: true, instances: await adminStore.listWhatsappInstances(auth, tenantId) });
});

api.post('/admin/whatsapp-instances', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  if (!canManageWhatsapp(auth)) {
    return c.json({ ok: false, error: 'usuário sem permissão para gerenciar WhatsApp' }, 403);
  }

  const body = await c.req.json().catch(() => null) as {
    tenantId?: string;
    instanceName?: string;
    ownerPhone?: string;
    createInEvolution?: boolean;
  } | null;

  const tenantId = writableTenantId(auth, body?.tenantId);
  const instanceName = cleanText(body?.instanceName, 80) || `robocote-${tenantId}-${Date.now()}`;
  const ownerPhone = normalizeManualPhone(body?.ownerPhone);

  if (body?.createInEvolution) {
    const created = await createEvolutionInstance({
      instanceName,
      ownerPhone: ownerPhone || undefined,
    });
    if (!created.ok) {
      return c.json({ ok: false, error: created.error, evolution: created }, 502);
    }
  }

  const record = await adminStore.createWhatsappInstance({
    tenantId,
    evolutionInstanceName: instanceName,
    ownerPhone: ownerPhone || undefined,
  });
  return c.json({ ok: true, instance: record }, 201);
});

api.post('/admin/whatsapp-instances/:instanceName/connect', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  if (!canManageWhatsapp(auth)) {
    return c.json({ ok: false, error: 'usuário sem permissão para gerenciar WhatsApp' }, 403);
  }

  const instanceName = c.req.param('instanceName');
  if (!(await canAccessWhatsappInstance(auth, instanceName))) {
    return c.json({ ok: false, error: 'instância WhatsApp fora do escopo do usuário' }, 404);
  }
  const result = await connectEvolutionInstance(instanceName);
  if (!result.ok) {
    await adminStore.updateWhatsappInstance(instanceName, { status: 'error' });
    return c.json({ ok: false, error: result.error, evolution: result }, 502);
  }
  const instance = await adminStore.updateWhatsappInstance(instanceName, {
    status: 'qrcode',
    lastQrAt: new Date().toISOString(),
  });
  return c.json({ ok: true, qr: result, instance });
});

api.get('/admin/whatsapp-instances/:instanceName/state', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  if (!canManageWhatsapp(auth)) {
    return c.json({ ok: false, error: 'usuário sem permissão para gerenciar WhatsApp' }, 403);
  }

  const instanceName = c.req.param('instanceName');
  if (!(await canAccessWhatsappInstance(auth, instanceName))) {
    return c.json({ ok: false, error: 'instância WhatsApp fora do escopo do usuário' }, 404);
  }
  const result = await getEvolutionConnectionState(instanceName);
  if (!result.ok) {
    await adminStore.updateWhatsappInstance(instanceName, { status: 'error' });
    return c.json({ ok: false, error: result.error, evolution: result }, 502);
  }
  const status = evolutionStateToWhatsappStatus(result.state);
  const instance = await adminStore.updateWhatsappInstance(instanceName, {
    status,
    lastConnectionState: result.state ?? null,
    connectedAt: status === 'connected' ? new Date().toISOString() : undefined,
    disconnectedAt: status === 'disconnected' || status === 'logged_out' ? new Date().toISOString() : undefined,
  });
  return c.json({ ok: true, state: result, instance });
});

api.get('/cotacoes/:guid/resumo', async (c) => {
  const guid = c.req.param('guid').trim();
  if (!guid) {
    return c.json({ ok: false, error: 'guid da cotacao é obrigatório' }, 400);
  }

  try {
    const ctx = readQuoteContext(guid);
    const agentName = await getAgentName(ctx?.tenantId ?? '');
    const summary = await getQuoteSummary(guid, ctx?.info, agentName);
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
    // Webchat F1 não tem tenantId no schema atual; cai pra env ROBOCOTE_TENANT_ID (default 'rpi').
    const result = await runAutoF1Quote(parsed.data, timeoutMs);
    const fullName = parsed.data.answers.name?.trim() ?? '';
    const firstName = fullName ? fullName.split(/\s+/)[0] : null;
    // Webchat F1 não tem tenantId no schema atual; cai pra env fallback (ROBOCOTE_AGENT_NAME).
    cacheQuoteContext(result.guid, {
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

api.get('/painel/leads', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  const sessions = await sessionStore.list(tenantScope(auth));
  const leads = sessions.map(serializeLead);
  return c.json({
    ok: true,
    auth,
    metrics: panelMetrics(leads),
    leads,
    ts: new Date().toISOString(),
  });
});

api.post('/painel/leads/manual', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const body = await c.req.json().catch(() => null) as {
    name?: string;
    phone?: string;
    source?: string;
    vehicleHint?: string;
    notes?: string;
    stage?: string;
  } | null;

  const auth = resolveAuthContext(c);
  const name = cleanText(body?.name, 120);
  const phone = normalizeManualPhone(body?.phone);
  const source = cleanText(body?.source, 80);
  const vehicleHint = cleanText(body?.vehicleHint, 160);
  const notes = cleanText(body?.notes, 600);
  const stage = (body?.stage ?? 'novos_leads') as PipelineStage;
  const tenantId = writableTenantId(auth, (body as { tenantId?: string } | null)?.tenantId);

  if (!name) {
    return c.json({ ok: false, error: 'nome do lead é obrigatório' }, 400);
  }
  if (!phone) {
    return c.json({ ok: false, error: 'WhatsApp válido é obrigatório' }, 400);
  }
  if (!PIPELINE_STAGES.some((item) => item.key === stage)) {
    return c.json({ ok: false, error: 'stage inválido' }, 400);
  }

  const key = { tenantId, channel: 'whatsapp' as const, channelUserId: phone };
  const existing = await sessionStore.get(key);
  const base = existing ?? createInitialSessionState(key);
  const answers: Record<string, SessionAnswer> = {
    ...base.answers,
    name: manualAnswer('name', 'Nome', name),
    contact: manualAnswer('contact', 'Contato', phone),
  };

  if (source) answers.source = manualAnswer('source', 'Origem', source);
  if (vehicleHint) answers.vehicle_hint = manualAnswer('vehicle_hint', 'Veículo informado', vehicleHint);
  if (notes) answers.notes = manualAnswer('notes', 'Observações', notes);

  const noteLines = [
    existing ? 'Lead atualizado manualmente no painel.' : 'Lead cadastrado manualmente no painel.',
    source ? `Origem: ${source}` : null,
    vehicleHint ? `Veículo informado: ${vehicleHint}` : null,
    notes ? `Observação: ${notes}` : null,
  ].filter(Boolean).join('\n');

  const nextState = appendSessionInteraction({
    ...base,
    answers,
    customerFirstName: firstNameFrom(name),
    pipelineStage: stage,
    stepId: base.completed ? base.stepId : 'vehicle_brand',
    completed: base.completed,
  }, {
    direction: 'system',
    text: noteLines,
    action: existing ? 'manual_update' : 'manual_create',
    stepId: base.completed ? base.stepId : 'vehicle_brand',
    quoteGuid: base.lastGuid,
  });

  const updated = await sessionStore.upsert(nextState);
  return c.json({ ok: true, lead: serializeLead(updated) }, existing ? 200 : 201);
});

api.patch('/painel/leads/:id/stage', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { stage?: string } | null;
  const auth = resolveAuthContext(c);
  const stage = body?.stage as PipelineStage | undefined;
  if (!stage || !PIPELINE_STAGES.some((item) => item.key === stage)) {
    return c.json({ ok: false, error: 'stage inválido' }, 400);
  }

  const sessions = await sessionStore.list(tenantScope(auth));
  const session = sessions.find((item) => stableLeadId(item) === id);
  if (!session) {
    return c.json({ ok: false, error: 'lead não encontrado' }, 404);
  }

  const updated = await sessionStore.upsert({ ...session, pipelineStage: stage });
  return c.json({ ok: true, lead: serializeLead(updated) });
});

/**
 * Intervenção humana — Camada 2: controle explícito via Painel.
 *
 * POST /api/painel/leads/:id/override
 * Body: { active: true|false, operatorId?: string }
 *
 * - active=true: marca humanOverride.active=true (source='panel_explicit'). Agente pausa
 *   imediatamente para esse lead até desativação manual ou timeout 24h.
 * - active=false: libera o agente. NÃO manda recap aqui — o recap dispara quando
 *   o lead enviar a próxima mensagem (mesmo caminho do timeout automático em C1).
 *
 * Camada 1 (detecção automática via WhatsApp Web) já funciona em paralelo;
 * essa rota cobre o caso do operador que prefere usar o Painel sem mandar
 * mensagem pelo WhatsApp Web antes.
 */
api.post('/painel/leads/:id/override', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { active?: boolean; operatorId?: string } | null;
  if (typeof body?.active !== 'boolean') {
    return c.json({ ok: false, error: 'active (boolean) é obrigatório' }, 400);
  }

  const auth = resolveAuthContext(c);
  const sessions = await sessionStore.list(tenantScope(auth));
  const session = sessions.find((item) => stableLeadId(item) === id);
  if (!session) {
    return c.json({ ok: false, error: 'lead não encontrado' }, 404);
  }

  const now = Date.now();
  const next: SessionState = body.active
    ? {
        ...session,
        humanOverride: {
          active: true,
          startedAt: session.humanOverride?.active ? session.humanOverride.startedAt : now,
          lastActivityAt: now,
          source: 'panel_explicit',
          operatorId: body.operatorId ?? auth.userId ?? undefined,
        },
      }
    : {
        ...session,
        humanOverride: null,
      };

  const updated = await sessionStore.upsert(next);
  return c.json({ ok: true, lead: serializeLead(updated), humanOverride: updated.humanOverride });
});

// ─── Configuração de cobertura Auto por tenant (seção Configurações do Painel) ──────
// Enums validados contra valores oficiais aceitos pela Segfy NJ (swagger-public.json).
const coverageAutoSchema = z.object({
  tipo_cobertura: z.enum(['exclusive', 'comprehensive', 'third_party_only']),
  tabela_fipe: z.number().int().min(0).max(200),
  franquia: z.enum(['normal', 'reduced_25', 'reduced_50', 'reduced_75', 'facultativa_50', 'facultativa_100']),
  isencao_franquia: z.boolean(),
  vidros: z.enum([
    'no_glass', 'glass_vip_referenced', 'glass_vip_unattached',
    'glass_basic_referenced', 'glass_basic_unattached',
    'glass_total_referenced', 'glass_total_unattached',
  ]),
  assistencia_24h: z.enum([
    'no_assistance', 'assistance_200_km_referenced', 'assistance_200_km_unattached',
    'assistance_500_km_referenced', 'assistance_500_km_unattached',
    'assistance_1000_km_referenced', 'assistance_1000_km_unattached',
    'assistance_no_limit_referenced', 'assistance_no_limit_unattached',
  ]),
  carro_reserva: z.enum([
    'no_car', 'rental_car_07_days_referenced', 'rental_car_07_days_unattached',
    'rental_car_15_days_referenced', 'rental_car_15_days_unattached',
    'rental_car_30_days_referenced', 'rental_car_30_days_unattached',
  ]),
  tipo_carro_reserva: z.enum(['basic', 'no_car', 'essential', 'executive']),
  reposicao_zero_km: z.enum(['no_replacement', 'zero_km_06_month', 'zero_km_12_month']),
  rcf_dm: z.number().int().min(0),
  rcf_dc: z.number().int().min(0),
  danos_morais: z.number().int().min(0),
  app_morte: z.number().int().min(0),
  desp_extras: z.number().int().min(0),
});

const coverageAutoPutSchema = z.object({
  coverage: coverageAutoSchema,
  seguradoras: z.array(z.string().min(1)).min(1).optional(),
  comissao_auto: z.number().min(0).max(100).optional(),
});

/**
 * GET /api/painel/config/coverage-auto — lê config de cobertura Auto do tenant logado.
 * Retorna 404 amigável quando tenant não tem config (ainda não passou pelo onboarding).
 */
api.get('/painel/config/coverage-auto', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  const tenantId = auth.tenantId ?? (auth.isSuperadmin ? c.req.query('tenantId') ?? '' : '');
  if (!tenantId) {
    return c.json({ ok: false, error: 'tenantId obrigatório (superadmin: passe ?tenantId=)' }, 400);
  }

  try {
    const config = await getTenantQuoteConfig(tenantId);
    return c.json({
      ok: true,
      tenantId,
      coverage: config.coberturas?.auto ?? null,
      seguradoras: config.seguradoras ?? [],
      comissao_auto: config.comissoes?.auto ?? null,
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message, tenantId }, 404);
  }
});

/**
 * PUT /api/painel/config/coverage-auto — grava nova versão de cobertura Auto.
 * Merge com a config existente (preserva outros ramos/campos), grava versão nova
 * em tenant_configs (insert-only) com source='panel_edit'.
 */
api.put('/painel/config/coverage-auto', async (c) => {
  const denied = requirePanelAccess(c);
  if (denied) return denied;

  const auth = resolveAuthContext(c);
  const tenantId = auth.tenantId ?? (auth.isSuperadmin ? (await c.req.json().catch(() => ({})))?.tenantId ?? '' : '');
  if (!tenantId) {
    return c.json({ ok: false, error: 'tenantId obrigatório' }, 400);
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = coverageAutoPutSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'payload inválido',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }

  // Carrega config atual pra fazer merge (preserva ramos/campos não tocados).
  let current: TenantQuoteConfigShape;
  try {
    current = await getTenantQuoteConfig(tenantId);
  } catch {
    // Tenant sem config ainda — cria base mínima
    current = { version: '2.0', plano: 'seguros', ramos: ['auto'] };
  }

  const coverage: CoverageAuto = parsed.data.coverage;
  const next: TenantQuoteConfigShape = {
    ...current,
    version: current.version ?? '2.0',
    ramos: current.ramos?.includes('auto') ? current.ramos : [...(current.ramos ?? []), 'auto'],
    seguradoras: parsed.data.seguradoras ?? current.seguradoras,
    comissoes: {
      ...current.comissoes,
      ...(parsed.data.comissao_auto !== undefined ? { auto: parsed.data.comissao_auto } : {}),
    },
    coberturas: { ...current.coberturas, auto: coverage },
  };

  try {
    const result = await saveTenantQuoteConfig(tenantId, next, {
      source: 'panel_edit',
      changedBy: auth.userId,
      changeNote: 'Edição de cobertura Auto via painel',
    });
    return c.json({ ok: true, tenantId, ...result });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});
