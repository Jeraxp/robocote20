import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { StepCoverageAuto, DEFAULT_COVERAGE_AUTO } from './StepCoverageAuto';
import { StepCoverageResidencial, DEFAULT_COVERAGE_RESIDENCIAL } from './StepCoverageResidencial';
import type { CoverageAuto, CoverageResidencial } from './types';
import {
  Activity,
  Bike,
  Building2,
  Car,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Home,
  X,
  Clock3,
  ExternalLink,
  Globe,
  LayoutDashboard,
  MessageCircle,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Truck,
  UserRound,
  UsersRound,
} from 'lucide-react';

interface PanelInteraction {
  id: string;
  at: string;
  direction: 'inbound' | 'outbound' | 'system';
  text: string;
  action: string | null;
  stepId: string | null;
  quoteGuid: string | null;
}

interface PanelAnswer {
  id: string;
  label: string;
  value: string;
}

interface PanelLead {
  id: string;
  tenantId: string;
  channel: 'webchat' | 'whatsapp';
  channelUser: string;
  name: string;
  firstName: string | null;
  status: { key: string; label: string };
  stage: { key: string; label: string };
  stepId: string;
  stepLabel: string;
  progress: number;
  vehicle: string;
  coveragePreference: string | null;
  quoteGuid: string | null;
  quoteRoomPath: string | null;
  createdAt: string;
  updatedAt: string;
  answers: PanelAnswer[];
  interactions: PanelInteraction[];
  latestMessage: string | null;
  humanOverride: {
    active: boolean;
    source: 'auto_detected' | 'panel_explicit';
    startedAt: string;
    lastActivityAt: string;
  } | null;
}

interface PanelResponse {
  ok: true;
  auth: PanelAuth;
  metrics: {
    total: number;
    active: number;
    ready: number;
    quoted: number;
    waiting: number;
  };
  leads: PanelLead[];
  ts: string;
}

interface PanelAuth {
  userId: string;
  name: string;
  email: string;
  role: 'superadmin' | 'admin' | 'operador';
  tenantId: string | null;
  tenantName: string | null;
  isSuperadmin: boolean;
  authMode: 'dev' | 'session';
  impersonatingTenantId?: string | null;
  mustChangePassword?: boolean;
}

interface AdminTenant {
  id: string;
  slug: string;
  name: string;
  documentType: 'cpf' | 'cnpj' | null;
  documentMasked: string | null;
  phoneMasked: string | null;
  managerName: string | null;
  managerEmail: string | null;
  managerPhoneMasked: string | null;
  status: string;
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  phoneMasked: string | null;
  status: string;
  role: PanelAuth['role'];
  tenantId: string | null;
}

interface AdminWhatsappInstance {
  id: string;
  tenantId: string;
  evolutionInstanceName: string;
  ownerPhone: string | null;
  cloudPhoneNumberId: string | null;
  channel: 'cloudapi' | 'evolution';
  status: string;
  createdAt?: string;
  lastConnectionState: string | null;
  lastQrAt: string | null;
  connectedAt: string | null;
}

interface EvolutionQrResult {
  ok: boolean;
  status: number;
  instanceName: string;
  pairingCode?: string;
  code?: string;
  base64?: string;
  count?: number;
}

interface AdminMeResponse {
  ok: true;
  auth: PanelAuth;
  capabilities: {
    manageUsers: boolean;
    manageWhatsapp: boolean;
    viewAllTenants: boolean;
  };
  tenants: AdminTenant[];
  navigation: Array<{ key: PanelSection; label: string; enabled: boolean }>;
}

interface ManualLeadForm {
  name: string;
  phone: string;
  source: string;
  vehicleHint: string;
  notes: string;
}

interface TenantForm {
  documentType: 'cnpj' | 'cpf';
  document: string;
  brokerName: string;
  brokerPhone: string;
  managerName: string;
  managerEmail: string;
  managerWhatsapp: string;
  createWhatsapp: boolean;
}

interface UserForm {
  tenantId: string;
  name: string;
  email: string;
  phone: string;
  role: 'admin' | 'operador';
  password: string;
}

interface WhatsappForm {
  tenantId: string;
  /** phone_number_id da Graph — chave estável do número (o display muda, o id não). */
  cloudPhoneNumberId: string;
  displayPhone: string;
}

type PanelSection = 'leads' | 'conversas' | 'tenants' | 'users' | 'whatsapp' | 'webchat' | 'settings' | 'support';

type PanelErrorResponse = { ok: false; error?: string; authRequired?: boolean };

const kanbanColumns = [
  { key: 'novos_leads', label: 'Novos Leads' },
  { key: 'contatados', label: 'Contatados' },
  { key: 'em_negociacao', label: 'Em Negociação' },
  { key: 'sem_retorno', label: 'Sem Retorno' },
  { key: 'vendas', label: 'Vendas' },
  { key: 'perdido', label: 'Perdido' },
  // Acervo espelhado do legado — fora do funil ativo, por último de propósito.
  { key: 'historico', label: 'Histórico' },
];

const PANEL_TOKEN_STORAGE_KEY = 'robocote.panelToken';

class PanelAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PanelAccessError';
  }
}

function readStoredPanelToken(): string {
  try {
    return window.sessionStorage.getItem(PANEL_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function persistPanelToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(PANEL_TOKEN_STORAGE_KEY, token);
    else window.sessionStorage.removeItem(PANEL_TOKEN_STORAGE_KEY);
  } catch {
    // sessionStorage pode estar bloqueado; o estado em memória mantém a sessão atual.
  }
}

function panelFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('x-robocote-panel-token', token);
  return fetch(path, { ...init, headers });
}

async function parsePanelResponse<T extends { ok: true }>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({ ok: false }))) as T | PanelErrorResponse;
  if (!response.ok || body.ok !== true) {
    const message = 'error' in body && body.error ? body.error : fallback;
    if (response.status === 401 && 'authRequired' in body && body.authRequired) {
      throw new PanelAccessError(message);
    }
    throw new Error(message);
  }
  return body;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'agora';
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

async function fetchPanelLeads(token: string): Promise<PanelResponse> {
  const response = await panelFetch('/api/painel/leads', token);
  return parsePanelResponse<PanelResponse>(response, 'Não foi possível carregar o painel.');
}

async function updateLeadStage(leadId: string, stage: string, token: string): Promise<PanelLead> {
  const response = await panelFetch(`/api/painel/leads/${encodeURIComponent(leadId)}/stage`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage }),
  });
  const body = await parsePanelResponse<{ ok: true; lead: PanelLead }>(response, 'Não foi possível mover o lead.');
  return body.lead;
}

async function setLeadOverride(leadId: string, active: boolean, token: string): Promise<PanelLead> {
  const response = await panelFetch(`/api/painel/leads/${encodeURIComponent(leadId)}/override`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  const body = await parsePanelResponse<{ ok: true; lead: PanelLead }>(response, 'Não foi possível alterar o controle do atendimento.');
  return body.lead;
}

async function createManualLead(input: ManualLeadForm, token: string): Promise<PanelLead> {
  const response = await panelFetch('/api/painel/leads/manual', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parsePanelResponse<{ ok: true; lead: PanelLead }>(response, 'Não foi possível cadastrar o lead.');
  return body.lead;
}

async function fetchAdminMe(token: string): Promise<AdminMeResponse> {
  const response = await panelFetch('/api/admin/me', token);
  return parsePanelResponse<AdminMeResponse>(response, 'Não foi possível carregar permissões.');
}

async function loginRequest(email: string, password: string): Promise<void> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json().catch(() => ({ ok: false }));
  if (!response.ok || !body.ok) {
    throw new Error(body.error ?? 'Não foi possível entrar.');
  }
}

async function logoutRequest(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
}

async function changePasswordRequest(currentPassword: string, newPassword: string): Promise<void> {
  const response = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const body = await response.json().catch(() => ({ ok: false }));
  if (!response.ok || !body.ok) {
    throw new Error(body.error ?? 'Não foi possível trocar a senha.');
  }
}

async function impersonateRequest(tenantId: string): Promise<void> {
  const response = await fetch('/api/auth/impersonate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId }),
  });
  const body = await response.json().catch(() => ({ ok: false }));
  if (!response.ok || !body.ok) {
    throw new Error(body.error ?? 'Não foi possível acessar o painel da corretora.');
  }
}

async function stopImpersonateRequest(): Promise<void> {
  await fetch('/api/auth/stop-impersonate', { method: 'POST' }).catch(() => undefined);
}

async function fetchAdminUsers(token: string): Promise<AdminUser[]> {
  const response = await panelFetch('/api/admin/users', token);
  const body = await parsePanelResponse<{ ok: true; users: AdminUser[] }>(response, 'Não foi possível carregar usuários.');
  return body.users;
}

async function fetchAdminTenants(token: string): Promise<AdminTenant[]> {
  const response = await panelFetch('/api/admin/tenants', token);
  const body = await parsePanelResponse<{ ok: true; tenants: AdminTenant[] }>(response, 'Não foi possível carregar corretoras.');
  return body.tenants;
}

async function createAdminTenant(input: TenantForm, token: string): Promise<{ tenant: AdminTenant; whatsapp?: { instance: AdminWhatsappInstance; evolution: { ok: boolean; error?: string } | null } }> {
  const response = await panelFetch('/api/admin/tenants', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parsePanelResponse<{ ok: true; tenant: AdminTenant; whatsapp?: { instance: AdminWhatsappInstance; evolution: { ok: boolean; error?: string } | null } }>(response, 'Não foi possível criar a corretora.');
  return { tenant: body.tenant, whatsapp: body.whatsapp };
}

async function createAdminUser(input: UserForm, token: string): Promise<AdminUser> {
  const response = await panelFetch('/api/admin/users', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parsePanelResponse<{ ok: true; user: AdminUser }>(response, 'Não foi possível criar usuário.');
  return body.user;
}

async function fetchWhatsappInstances(token: string): Promise<AdminWhatsappInstance[]> {
  const response = await panelFetch('/api/admin/whatsapp-instances', token);
  const body = await parsePanelResponse<{ ok: true; instances: AdminWhatsappInstance[] }>(response, 'Não foi possível carregar WhatsApp.');
  return body.instances;
}

async function createWhatsappInstance(input: WhatsappForm, token: string): Promise<AdminWhatsappInstance> {
  const response = await panelFetch('/api/admin/whatsapp-instances', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parsePanelResponse<{ ok: true; instance: AdminWhatsappInstance }>(response, 'Não foi possível criar instância WhatsApp.');
  return body.instance;
}

async function connectWhatsappInstance(instanceName: string, token: string): Promise<{ qr: EvolutionQrResult; instance: AdminWhatsappInstance | null }> {
  const response = await panelFetch(`/api/admin/whatsapp-instances/${encodeURIComponent(instanceName)}/connect`, token, {
    method: 'POST',
  });
  const body = await parsePanelResponse<{ ok: true; qr: EvolutionQrResult; instance: AdminWhatsappInstance | null }>(response, 'Não foi possível gerar QR Code.');
  return { qr: body.qr, instance: body.instance };
}

async function refreshWhatsappState(instanceName: string, token: string): Promise<AdminWhatsappInstance | null> {
  const response = await panelFetch(`/api/admin/whatsapp-instances/${encodeURIComponent(instanceName)}/state`, token);
  const body = await parsePanelResponse<{ ok: true; instance: AdminWhatsappInstance | null }>(response, 'Não foi possível consultar estado.');
  return body.instance;
}

function StatusPill({ status }: { status: PanelLead['status'] }): JSX.Element {
  return <span className={`panel-status is-${status.key}`}>{status.label}</span>;
}

function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
  label: string;
  value: number;
}): JSX.Element {
  return (
    <article className="panel-metric">
      <Icon size={20} />
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function LoginScreen({
  email,
  password,
  loading,
  error,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: {
  email: string;
  password: string;
  loading: boolean;
  error: string | null;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <main className="panel-access-shell">
      <section className="panel-access-card">
        <div className="panel-access-icon">
          <ShieldCheck size={28} />
        </div>
        <div>
          <span>Painel Robocote</span>
          <h1>Entrar</h1>
          <p>Acesse com seu e-mail e senha para abrir o painel da sua corretora.</p>
        </div>
        <form
          className="panel-access-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label>
            E-mail
            <input
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              placeholder="voce@suacorretora.com"
              autoFocus
              type="email"
              autoComplete="username"
            />
          </label>
          <label>
            Senha
            <input
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder="Sua senha"
              type="password"
              autoComplete="current-password"
            />
          </label>
          {error ? <p>{error}</p> : null}
          <button type="submit" className="panel-refresh" disabled={loading}>
            {loading ? <RefreshCw size={17} /> : <ShieldCheck size={17} />}
            Entrar
          </button>
        </form>
      </section>
    </main>
  );
}

/** Tela de troca obrigatória de senha (primeiro acesso com senha temporária). */
function ChangePasswordScreen({
  newPassword,
  confirmPassword,
  loading,
  error,
  onNewChange,
  onConfirmChange,
  onSubmit,
}: {
  newPassword: string;
  confirmPassword: string;
  loading: boolean;
  error: string | null;
  onNewChange: (v: string) => void;
  onConfirmChange: (v: string) => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <main className="panel-access-shell">
      <section className="panel-access-card">
        <div className="panel-access-icon">
          <ShieldCheck size={28} />
        </div>
        <div>
          <span>Primeiro acesso</span>
          <h1>Defina sua senha</h1>
          <p>Por segurança, escolha uma senha nova antes de continuar.</p>
        </div>
        <form
          className="panel-access-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label>
            Nova senha
            <input value={newPassword} onChange={(e) => onNewChange(e.target.value)} type="password" autoComplete="new-password" autoFocus />
          </label>
          <label>
            Confirme a nova senha
            <input value={confirmPassword} onChange={(e) => onConfirmChange(e.target.value)} type="password" autoComplete="new-password" />
          </label>
          {error ? <p>{error}</p> : null}
          <button type="submit" className="panel-refresh" disabled={loading}>
            {loading ? <RefreshCw size={17} /> : <ShieldCheck size={17} />}
            Salvar e entrar
          </button>
        </form>
      </section>
    </main>
  );
}

function ManualLeadModal({
  open,
  values,
  saving,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  values: ManualLeadForm;
  saving: boolean;
  error: string | null;
  onChange: (values: ManualLeadForm) => void;
  onClose: () => void;
  onSubmit: () => void;
}): JSX.Element | null {
  if (!open) return null;

  const update = (key: keyof ManualLeadForm, value: string): void => {
    onChange({ ...values, [key]: value });
  };

  return (
    <div className="lead-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="manual-lead-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Adicionar novo lead"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="manual-lead-header">
          <div>
            <span>Novo lead</span>
            <h2>Adicionar novo lead</h2>
            <p>Cadastre indicações ou contatos captados pelo corretor.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar cadastro">
            <X size={20} />
          </button>
        </header>

        <form
          className="manual-lead-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label>
            Nome completo
            <input
              data-testid="manual-lead-name"
              value={values.name}
              onChange={(event) => update('name', event.target.value)}
              placeholder="Ex.: Mariana Costa"
              required
              autoFocus
            />
          </label>

          <label>
            WhatsApp
            <input
              data-testid="manual-lead-phone"
              value={values.phone}
              onChange={(event) => update('phone', event.target.value)}
              placeholder="Ex.: (11) 99999-9999"
              inputMode="tel"
              required
            />
          </label>

          <label>
            Origem
            <input
              data-testid="manual-lead-source"
              value={values.source}
              onChange={(event) => update('source', event.target.value)}
              placeholder="Ex.: indicação, Instagram, prospecção"
            />
          </label>

          <label>
            Veículo informado
            <input
              data-testid="manual-lead-vehicle"
              value={values.vehicleHint}
              onChange={(event) => update('vehicleHint', event.target.value)}
              placeholder="Ex.: Jeep Compass 2024"
            />
          </label>

          <label className="manual-lead-wide">
            Observações
            <textarea
              data-testid="manual-lead-notes"
              value={values.notes}
              onChange={(event) => update('notes', event.target.value)}
              placeholder="Contexto livre para o atendimento."
              rows={4}
            />
          </label>

          {error ? <p className="manual-lead-error">{error}</p> : null}

          <div className="manual-lead-actions">
            <button type="button" className="manual-lead-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="panel-refresh" disabled={saving}>
              {saving ? <RefreshCw size={17} /> : <Save size={17} />}
              Salvar lead
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function LeadCard({
  lead,
  selected,
  onSelect,
}: {
  lead: PanelLead;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button type="button" className={`kanban-card${selected ? ' selected' : ''}`} onClick={onSelect}>
      <div className="kanban-card-top">
        <strong>{lead.name}</strong>
        <time>{formatTime(lead.updatedAt)}</time>
      </div>
      <p>{lead.vehicle}</p>
      <div className="kanban-card-meta">
        <span>{lead.channelUser}</span>
        <StatusPill status={lead.status} />
      </div>
      <div className="lead-progress" aria-label={`Progresso ${lead.progress}%`}>
        <span style={{ width: `${lead.progress}%` }} />
      </div>
      {lead.latestMessage ? <small>{lead.latestMessage}</small> : null}
    </button>
  );
}

function ConversationPanel({ lead }: { lead: PanelLead | null }): JSX.Element {
  if (!lead) {
    return (
      <section className="panel-surface conversation-panel empty">
        <MessageCircle size={34} />
        <h2>Nenhum lead selecionado</h2>
        <p>Assim que uma conversa chegar pelo WhatsApp, ela aparece aqui para acompanhamento.</p>
      </section>
    );
  }

  return (
    <section className="panel-surface conversation-panel">
      <header className="conversation-header">
        <div>
          <span>Conversa</span>
          <h2>{lead.name}</h2>
        </div>
        <StatusPill status={lead.status} />
      </header>

      <div className="conversation-feed">
        {lead.interactions.length > 0 ? (
          lead.interactions.map((item) => (
            <article key={item.id} className={`panel-message ${item.direction}`}>
              <div className="panel-message-meta">
                <span>{item.direction === 'inbound' ? 'Lead' : item.direction === 'outbound' ? 'Robocote' : 'Sistema'}</span>
                <time>{formatTime(item.at)}</time>
              </div>
              <p>{item.text}</p>
              {item.action ? <small>{item.action}</small> : null}
            </article>
          ))
        ) : (
          <div className="conversation-empty">
            <Clock3 size={26} />
            <p>Sem mensagens registradas nesta sessão ainda.</p>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Última atividade DE CONVERSA — nunca o updatedAt da sessão.
 * O espelho do legado reescreve updated_at o tempo todo; confiar nele faria
 * lead do acervo "furar a fila" na lista sem ninguém ter dito uma palavra.
 */
function lastConversationAt(lead: PanelLead): number {
  for (let i = lead.interactions.length - 1; i >= 0; i--) {
    const item = lead.interactions[i];
    if (item.direction === 'inbound' || item.direction === 'outbound') {
      const ts = new Date(item.at).getTime();
      if (Number.isFinite(ts)) return ts;
    }
  }
  return 0;
}

/**
 * Conversa DE VERDADE = pelo menos uma fala de gente ou do agente.
 * Sem este filtro, os 150 mil leads do acervo (interações só de sistema,
 * carimbo do espelho) afogariam a lista no primeiro scroll.
 */
function hasRealConversation(lead: PanelLead): boolean {
  return lead.interactions.some((item) => item.direction === 'inbound' || item.direction === 'outbound');
}

/** Hora se foi hoje; dia/mês + hora se foi antes. */
function formatConversaTime(ts: number): string {
  if (!ts) return '';
  const date = new Date(ts);
  const hoje = new Date();
  const mesmoDia = date.toDateString() === hoje.toDateString();
  return new Intl.DateTimeFormat('pt-BR', mesmoDia
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

const channelBadge: Record<PanelLead['channel'], string> = {
  whatsapp: 'WhatsApp',
  webchat: 'Webchat',
};

/**
 * Carimbo de ação traduzido pro corretor. O que não está aqui é mecânica
 * interna (answer_step, none…) e fica invisível — carimbo é pra marcar
 * momento que muda a conversa, não pra ensinar o vocabulário do motor.
 */
const actionLabels: Record<string, string> = {
  greet: 'saudação',
  service_type: 'escolha de atendimento',
  branch_selected: 'ramo escolhido',
  calculate: 'cotação disparada',
  calc_failed: 'falha na cotação',
  reset: 'conversa reiniciada',
  human_handoff_requested: 'atendente solicitado',
  human_handoff_back: 'agente reassumiu',
  human_intervention: 'humano respondeu',
  human_paused: 'agente pausado',
  unsupported_media: 'mídia não lida',
};

/**
 * Aba Conversas — Etapa A: acompanhar, não intervir (decisão Jera 2026-08-30).
 *
 * Lista à esquerda, linha do tempo à direita, tudo alimentado pelo MESMO
 * payload/polling de 10s que o resto do painel já usa — zero endpoint novo.
 * O botão de assumir a conversa é a Etapa B, desenhada em separado porque
 * mexe em conversa com cliente real.
 */
function ConversasSection({ leads, token, onRefresh }: {
  leads: PanelLead[];
  token: string;
  onRefresh: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const conversas = useMemo(() => {
    const term = query.trim().toLowerCase();
    return leads
      .filter(hasRealConversation)
      .filter((lead) => {
        if (!term) return true;
        return (
          lead.name.toLowerCase().includes(term) ||
          lead.channelUser.toLowerCase().includes(term) ||
          (lead.latestMessage ?? '').toLowerCase().includes(term)
        );
      })
      .sort((a, b) => lastConversationAt(b) - lastConversationAt(a));
  }, [leads, query]);

  // Mais de uma corretora na lista? Mostra a etiqueta (visão de superadmin).
  const multiTenant = useMemo(
    () => new Set(conversas.map((c) => c.tenantId)).size > 1,
    [conversas],
  );

  const selected = conversas.find((c) => c.id === selectedId) ?? conversas[0] ?? null;

  // Crava a seleção assim que existe lista: sem isso, o poll de 10s reordenaria
  // a conversa aberta por baixo do operador — e o rascunho iria pro lead errado.
  useEffect(() => {
    if (!selectedId && conversas.length > 0) setSelectedId(conversas[0].id);
  }, [selectedId, conversas]);

  // Conversa nova ao vivo: mantém o feed grudado no fim, como um chat de verdade.
  const lastInteractionId = selected?.interactions.at(-1)?.id ?? null;
  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [selected?.id, lastInteractionId]);

  // Etapa B (decisões Jera 2026-09-01): escrever É assumir — o backend pausa o
  // agente e avisa o lead na primeira mensagem. Por isso não existe botão
  // "Assumir" separado: o gesto que assume é o de falar.
  async function enviarMensagem(): Promise<void> {
    if (!selected || !draft.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const response = await panelFetch(`/api/painel/leads/${selected.id}/mensagem`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: draft.trim() }),
      });
      await parsePanelResponse(response, 'não consegui enviar a mensagem');
      setDraft('');
      onRefresh();
    } catch (error) {
      setSendError((error as Error).message);
      // O servidor pode ter assumido a conversa mesmo com o envio falhando —
      // atualiza pra UI mostrar o estado real (botão Devolver, placeholder certo).
      onRefresh();
    } finally {
      setSending(false);
    }
  }

  async function devolverProAgente(): Promise<void> {
    if (!selected || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const response = await panelFetch(`/api/painel/leads/${selected.id}/override`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active: false }),
      });
      const resultado = await parsePanelResponse<{ ok: true; aviso?: string }>(response, 'não consegui devolver a conversa');
      // "Devolvi" com recado perdido não é sucesso limpo — o operador precisa saber.
      if (resultado.aviso) setSendError(resultado.aviso);
      onRefresh();
    } catch (error) {
      setSendError((error as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="panel-section-page conversas-page">
      <header className="panel-hero compact">
        <div>
          <h1>Conversas</h1>
          <p>O agente atende, você acompanha ao vivo — cada fala carimbada.</p>
        </div>
      </header>

      <div className="panel-surface conversas-shell">
        <aside className="conversas-list">
          <label className="panel-search">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por nome, telefone ou mensagem"
            />
          </label>

          <div className="conversas-scroll">
            {conversas.length === 0 ? (
              <div className="conversation-empty">
                <MessageCircle size={26} />
                <p>{query ? 'Nada encontrado com essa busca.' : 'Nenhuma conversa ainda. Quando um lead falar com o agente, ela nasce aqui.'}</p>
              </div>
            ) : (
              conversas.map((lead) => {
                const ativa = selected?.id === lead.id;
                return (
                  <button
                    key={lead.id}
                    type="button"
                    className={`conversa-item${ativa ? ' is-active' : ''}`}
                    onClick={() => setSelectedId(lead.id)}
                  >
                    <div className="conversa-item-top">
                      <strong>{lead.name}</strong>
                      <time>{formatConversaTime(lastConversationAt(lead))}</time>
                    </div>
                    <div className="conversa-item-tags">
                      <span className={`conversa-canal is-${lead.channel}`}>{channelBadge[lead.channel]}</span>
                      {multiTenant ? <span className="conversa-tenant">{lead.tenantId}</span> : null}
                      {lead.humanOverride?.active ? <span className="conversa-humano">humano na linha</span> : null}
                    </div>
                    <p>{lead.latestMessage ?? 'Sem mensagens ainda.'}</p>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <div className="conversas-thread">
          {selected ? (
            <>
              <header className="conversas-thread-header">
                <div>
                  <h2>{selected.name}</h2>
                  <p>
                    {/* Telefone é identidade útil; id interno de webchat é ruído. */}
                    {selected.channel === 'whatsapp' ? `${selected.channelUser} · ` : ''}
                    {channelBadge[selected.channel]}
                    {multiTenant ? ` · ${selected.tenantId}` : ''}
                  </p>
                </div>
                <div className="conversas-thread-meta">
                  {selected.humanOverride?.active ? (
                    <button
                      type="button"
                      className="conversa-devolver"
                      disabled={sending}
                      onClick={() => void devolverProAgente()}
                    >
                      Devolver pro agente
                    </button>
                  ) : null}
                  <StatusPill status={selected.status} />
                  {selected.quoteRoomPath ? (
                    <a className="conversa-quote-link" href={selected.quoteRoomPath} target="_blank" rel="noreferrer">
                      Ver cotação
                    </a>
                  ) : null}
                </div>
              </header>
              <div className="conversation-feed conversas-feed" ref={feedRef}>
                {selected.interactions
                  .filter((item) => item.direction !== 'system')
                  .map((item) => (
                    <article key={item.id} className={`panel-message ${item.direction}`}>
                      <div className="panel-message-meta">
                        <span>{item.direction === 'inbound' ? selected.firstName ?? 'Lead' : 'Agente'}</span>
                        <time>{formatDateTime(item.at)}</time>
                      </div>
                      <p>{item.text}</p>
                      {item.action && actionLabels[item.action] ? (
                        <small>{actionLabels[item.action]}</small>
                      ) : null}
                    </article>
                  ))}
              </div>
              {selected.channel === 'whatsapp' ? (
                <footer className="conversas-composer">
                  {sendError ? <p className="conversas-composer-erro">{sendError}</p> : null}
                  <div className="conversas-composer-row">
                    <textarea
                      value={draft}
                      rows={2}
                      placeholder={selected.humanOverride?.active
                        ? 'Escreva sua resposta — você está na linha.'
                        : 'Escrever assume a conversa: o agente pausa e o lead é avisado.'}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          void enviarMensagem();
                        }
                      }}
                    />
                    <button
                      type="button"
                      disabled={sending || !draft.trim()}
                      onClick={() => void enviarMensagem()}
                    >
                      {sending ? 'Enviando…' : 'Enviar'}
                    </button>
                  </div>
                </footer>
              ) : (
                <footer className="conversas-composer is-webchat">
                  <p>Responder pelo painel chega primeiro no WhatsApp — no webchat, acompanhe por aqui.</p>
                </footer>
              )}
            </>
          ) : (
            <div className="conversation-empty conversas-vazia">
              <MessageCircle size={34} />
              <p>Escolha uma conversa na lista para acompanhar.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function LeadDetails({ lead }: { lead: PanelLead | null }): JSX.Element {
  if (!lead) {
    return (
      <aside className="panel-surface lead-details empty">
        <ShieldCheck size={28} />
        <p>Dados do lead protegidos aparecem aqui.</p>
      </aside>
    );
  }

  return (
    <aside className="panel-surface lead-details">
      <div className="details-title">
        <UserRound size={20} />
        <div>
          <span>Ficha do lead</span>
          <strong>{lead.channelUser}</strong>
        </div>
      </div>

      <dl className="lead-facts">
        <div>
          <dt>Status</dt>
          <dd>{lead.status.label}</dd>
        </div>
        <div>
          <dt>Etapa atual</dt>
          <dd>{lead.stepLabel}</dd>
        </div>
        <div>
          <dt>Atualizado</dt>
          <dd>{formatDateTime(lead.updatedAt)}</dd>
        </div>
        <div>
          <dt>Perfil</dt>
          <dd>{lead.coveragePreference ?? 'A definir'}</dd>
        </div>
      </dl>

      {lead.quoteRoomPath ? (
        <a className="panel-link-button" href={lead.quoteRoomPath} target="_blank" rel="noreferrer">
          Abrir Quote Room
          <ExternalLink size={15} />
        </a>
      ) : null}

      <section className="answers-section">
        <h3>Dados coletados</h3>
        {lead.answers.length > 0 ? (
          <dl>
            {lead.answers.map((answer) => (
              <div key={answer.id}>
                <dt>{answer.label}</dt>
                <dd>{answer.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>Nenhum dado estruturado ainda.</p>
        )}
      </section>
    </aside>
  );
}

function LeadModal({
  lead,
  onClose,
  onStageChange,
  onToggleOverride,
}: {
  lead: PanelLead | null;
  onClose: () => void;
  onStageChange: (stage: string) => void;
  onToggleOverride: (active: boolean) => void;
}): JSX.Element | null {
  if (!lead) return null;

  const overrideActive = lead.humanOverride?.active ?? false;

  return (
    <div className="lead-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="lead-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Detalhes de ${lead.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="lead-modal-header">
          <div>
            <span>{lead.stage.label}</span>
            <h2>{lead.name}</h2>
            <p>{lead.vehicle}</p>
          </div>
          <div className="lead-modal-actions">
            <button
              type="button"
              className={overrideActive ? 'lead-override-btn lead-override-active' : 'lead-override-btn'}
              onClick={() => onToggleOverride(!overrideActive)}
              title={overrideActive
                ? 'O agente está pausado. Clique para devolver o atendimento ao bot.'
                : 'Assumir o atendimento — o agente para de responder este lead.'}
            >
              {overrideActive ? <MessageCircle size={16} /> : <UserRound size={16} />}
              {overrideActive ? 'Devolver pro Bot' : 'Assumir atendimento'}
            </button>
            <label className="lead-stage-select">
              <span>Mover para</span>
              <select value={lead.stage.key} onChange={(event) => onStageChange(event.target.value)}>
                {kanbanColumns.map((column) => (
                  <option key={column.key} value={column.key}>
                    {column.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={onClose} aria-label="Fechar detalhes">
              <X size={20} />
            </button>
          </div>
        </header>
        {overrideActive ? (
          <div className="lead-override-banner">
            🟡 Atendimento humano ativo
            {lead.humanOverride?.source === 'auto_detected' ? ' (detectado pelo WhatsApp)' : ''}
            {lead.humanOverride?.startedAt
              ? ` desde ${new Date(lead.humanOverride.startedAt).toLocaleString('pt-BR')}`
              : ''}
            . O agente não responde até você devolver ou após 24h sem atividade.
          </div>
        ) : null}
        <div className="lead-modal-content">
          <ConversationPanel lead={lead} />
          <LeadDetails lead={lead} />
        </div>
      </section>
    </div>
  );
}

const sectionIcons: Record<PanelSection, typeof Activity> = {
  leads: LayoutDashboard,
  conversas: MessageCircle,
  tenants: Building2,
  users: UsersRound,
  whatsapp: Smartphone,
  webchat: Globe,
  settings: Settings,
  support: ShieldCheck,
};

function roleLabel(role: PanelAuth['role']): string {
  if (role === 'superadmin') return 'SUPERADMIN';
  if (role === 'admin') return 'ADMIN';
  return 'OPERADOR';
}

function PanelSidebar({
  admin,
  active,
  onSelect,
  onLogout,
}: {
  admin: AdminMeResponse | null;
  active: PanelSection;
  onSelect: (section: PanelSection) => void;
  onLogout: () => void;
}): JSX.Element {
  const nav = admin?.navigation ?? [
    { key: 'leads' as const, label: 'Leads / CRM', enabled: true },
    { key: 'conversas' as const, label: 'Conversas', enabled: true },
    { key: 'tenants' as const, label: 'Corretoras', enabled: false },
    { key: 'users' as const, label: 'Usuários', enabled: false },
    { key: 'whatsapp' as const, label: 'WhatsApp', enabled: false },
    { key: 'webchat' as const, label: 'Webchat', enabled: false },
  ];

  return (
    <aside className="panel-sidebar">
      <div className="panel-sidebar-brand">
        <Building2 size={22} />
        <div>
          <strong>{admin?.auth.tenantName ?? 'Robocote'}</strong>
          <span>{admin ? roleLabel(admin.auth.role) : 'Carregando'}</span>
        </div>
      </div>

      <nav className="panel-sidebar-nav" aria-label="Navegação operacional">
        {nav.map((item) => {
          const Icon = sectionIcons[item.key] ?? LayoutDashboard;
          return (
            <button
              key={item.key}
              type="button"
              className={active === item.key ? 'active' : ''}
              disabled={!item.enabled}
              onClick={() => onSelect(item.key)}
            >
              <Icon size={17} />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="panel-sidebar-footer">
        <span>{admin?.auth.email ?? 'dev mode'}</span>
        <small>{admin ? roleLabel(admin.auth.role) : 'Auth alpha'}{admin?.auth.authMode === 'dev' ? ' · token' : ''}</small>
        <button type="button" className="panel-logout-btn" onClick={onLogout}>
          <X size={15} /> Sair
        </button>
      </div>
    </aside>
  );
}

function UsersSection({
  admin,
  tenants,
  values,
  users,
  loading,
  saving,
  error,
  onChange,
  onSubmit,
  onRefresh,
}: {
  admin: AdminMeResponse | null;
  tenants: AdminTenant[];
  values: UserForm;
  users: AdminUser[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  onChange: (values: UserForm) => void;
  onSubmit: () => void;
  onRefresh: () => void;
}): JSX.Element {
  const isSuperadmin = admin?.auth.isSuperadmin ?? false;
  const update = (key: keyof UserForm, value: string): void => {
    onChange({ ...values, [key]: value });
  };

  return (
    <section className="panel-section-page">
      <header className="panel-hero compact">
        <div>
          <h1>Usuários</h1>
          <p>Hierarquia operacional: Taskdun, gestores de corretora e operadores.</p>
        </div>
        <button type="button" className="panel-refresh" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={17} />
          Atualizar
        </button>
      </header>

      <section className="panel-surface admin-create-card">
        <div className="admin-card-header">
          <div>
            <strong>Novo usuário</strong>
            <span>{isSuperadmin ? 'Crie gestores ou operadores por corretora.' : 'Gestor cadastra operadores da própria corretora.'}</span>
          </div>
        </div>
        <form
          className="admin-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {isSuperadmin ? (
            <label>
              Corretora
              <select value={values.tenantId} onChange={(event) => update('tenantId', event.target.value)} required>
                <option value="">Selecione</option>
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label>
            Nome
            <input
              value={values.name}
              onChange={(event) => update('name', event.target.value)}
              placeholder="Nome completo"
              required
            />
          </label>

          <label>
            Email
            <input
              value={values.email}
              onChange={(event) => update('email', event.target.value)}
              placeholder="operador@corretora.com.br"
              type="email"
              required
            />
          </label>

          <label>
            WhatsApp
            <input
              value={values.phone}
              onChange={(event) => update('phone', event.target.value)}
              placeholder="(11) 99999-9999"
              inputMode="tel"
            />
          </label>

          <label>
            Perfil
            <select value={values.role} onChange={(event) => update('role', event.target.value)} disabled={!isSuperadmin}>
              {isSuperadmin ? <option value="admin">ADMIN</option> : null}
              <option value="operador">OPERADOR</option>
            </select>
          </label>

          <label>
            Senha inicial
            <input
              value={values.password}
              onChange={(event) => update('password', event.target.value)}
              placeholder="Mín. 6 caracteres — o usuário troca no 1º acesso"
              type="text"
              minLength={6}
              required
            />
          </label>

          {error ? <p className="manual-lead-error">{error}</p> : null}

          <div className="manual-lead-actions">
            <button type="submit" className="panel-refresh" disabled={saving}>
              {saving ? <RefreshCw size={17} /> : <Save size={17} />}
              Criar usuário
            </button>
          </div>
        </form>
      </section>

      <div className="panel-surface admin-table-card">
        {error ? <p className="admin-empty">{error}</p> : null}
        <table className="admin-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Email</th>
              <th>WhatsApp</th>
              <th>Perfil</th>
              <th>Tenant</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={`${user.tenantId ?? 'global'}-${user.id}`}>
                <td>{user.name}</td>
                <td>{user.email}</td>
                <td>{user.phoneMasked ?? 'Não informado'}</td>
                <td>{roleLabel(user.role)}</td>
                <td>{user.tenantId ?? 'Taskdun'}</td>
                <td>{user.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && users.length === 0 ? <p className="admin-empty">Nenhum usuário cadastrado neste escopo.</p> : null}
      </div>
    </section>
  );
}

function TenantsSection({
  tenants,
  values,
  saving,
  loading,
  error,
  onChange,
  onSubmit,
  onRefresh,
  onImpersonate,
}: {
  tenants: AdminTenant[];
  values: TenantForm;
  saving: boolean;
  loading: boolean;
  error: string | null;
  onChange: (values: TenantForm) => void;
  onSubmit: () => void;
  onRefresh: () => void;
  onImpersonate: (tenantId: string) => void;
}): JSX.Element {
  const update = (key: keyof TenantForm, value: string): void => {
    onChange({ ...values, [key]: value });
  };

  return (
    <section className="panel-section-page">
      <header className="panel-hero compact">
        <div>
          <h1>Corretoras</h1>
          <p>Crie clientes, gere o tenant e atribua o gestor ADMIN da corretora.</p>
        </div>
        <button type="button" className="panel-refresh" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={17} />
          Atualizar
        </button>
      </header>

      <section className="panel-surface admin-create-card">
        <div className="admin-card-header">
          <div>
            <strong>Nova corretora</strong>
            <span>SUPERADMIN cria o cliente e o primeiro gestor.</span>
          </div>
        </div>
        <form
          className="admin-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label>
            Documento
            <div className="admin-inline-fields">
              <select value={values.documentType} onChange={(event) => update('documentType', event.target.value)}>
                <option value="cnpj">CNPJ</option>
                <option value="cpf">CPF</option>
              </select>
              <input
                value={values.document}
                onChange={(event) => update('document', event.target.value)}
                placeholder={values.documentType === 'cnpj' ? '00.000.000/0000-00' : '000.000.000-00'}
                required
              />
            </div>
          </label>

          <label>
            Nome da corretora
            <input
              value={values.brokerName}
              onChange={(event) => update('brokerName', event.target.value)}
              placeholder="Ex.: Protecta Seguros"
              required
            />
          </label>

          <label>
            Telefone da corretora
            <input
              value={values.brokerPhone}
              onChange={(event) => update('brokerPhone', event.target.value)}
              placeholder="(11) 99999-9999"
              inputMode="tel"
              required
            />
          </label>

          <label>
            Gestor
            <input
              value={values.managerName}
              onChange={(event) => update('managerName', event.target.value)}
              placeholder="Nome completo"
              required
            />
          </label>

          <label>
            Email do gestor
            <input
              value={values.managerEmail}
              onChange={(event) => update('managerEmail', event.target.value)}
              placeholder="gestor@corretora.com.br"
              type="email"
              required
            />
          </label>

          <label>
            WhatsApp do gestor
            <input
              value={values.managerWhatsapp}
              onChange={(event) => update('managerWhatsapp', event.target.value)}
              placeholder="(11) 99999-9999"
              inputMode="tel"
              required
            />
          </label>

          <label className="admin-checkbox-field">
            <input
              type="checkbox"
              checked={values.createWhatsapp}
              onChange={(event) => onChange({ ...values, createWhatsapp: event.target.checked })}
            />
            Criar instância WhatsApp
          </label>

          {error ? <p className="manual-lead-error">{error}</p> : null}

          <div className="manual-lead-actions">
            <button type="submit" className="panel-refresh" disabled={saving}>
              {saving ? <RefreshCw size={17} /> : <Save size={17} />}
              Criar corretora
            </button>
          </div>
        </form>
      </section>

      <div className="panel-surface admin-table-card">
        <div className="admin-card-header">
          <div>
            <strong>Clientes</strong>
            <span>{loading ? 'Carregando...' : `${tenants.length} corretora(s)`}</span>
          </div>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Corretora</th>
              <th>Documento</th>
              <th>Telefone</th>
              <th>Gestor</th>
              <th>Tenant</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr key={tenant.id}>
                <td>{tenant.name}</td>
                <td>{tenant.documentMasked ?? 'Não informado'}</td>
                <td>{tenant.phoneMasked ?? 'Não informado'}</td>
                <td>
                  {tenant.managerName ?? 'Sem gestor'}
                  {tenant.managerEmail ? <small>{tenant.managerEmail}</small> : null}
                </td>
                <td>{tenant.id}</td>
                <td>{tenant.status}</td>
                <td>
                  <button type="button" className="tenant-access-btn" onClick={() => onImpersonate(tenant.id)}>
                    <ExternalLink size={14} /> Acessar painel
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && tenants.length === 0 ? <p className="admin-empty">Nenhuma corretora cadastrada.</p> : null}
      </div>
    </section>
  );
}

function WhatsappSection({
  admin,
  tenants,
  values,
  instances,
  loading,
  saving,
  error,
  onChange,
  onSubmit,
  onRefresh,
}: {
  admin: AdminMeResponse | null;
  tenants: AdminTenant[];
  values: WhatsappForm;
  instances: AdminWhatsappInstance[];
  loading: boolean;
  saving: boolean;
  connectingName: string | null;
  selectedQr: { instanceName: string; qr: EvolutionQrResult } | null;
  error: string | null;
  onChange: (values: WhatsappForm) => void;
  onSubmit: () => void;
  onConnect: (instanceName: string) => void;
  onState: (instanceName: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  const isSuperadmin = admin?.auth.isSuperadmin ?? false;
  const update = (key: keyof WhatsappForm, value: string): void => {
    onChange({ ...values, [key]: value });
  };
  // Canal oficial é o produto; o legado (QR) só aparece como contagem, sem ação —
  // zero conversas em 30 dias e nenhuma instância jamais conectou.
  const oficiais = instances.filter((item) => item.channel === 'cloudapi');
  const legado = instances.length - oficiais.length;
  const tenantName = (id: string): string => tenants.find((t) => t.id === id)?.name ?? id;

  return (
    <section className="panel-section-page">
      <header className="panel-hero compact">
        <div>
          <h1>Canal oficial de WhatsApp</h1>
          <p>Números oficiais por corretora. O agente atende por eles — sem QR, sem celular ligado.</p>
        </div>
        <button type="button" className="panel-refresh" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={17} />
          Atualizar
        </button>
      </header>

      <section className="panel-surface admin-create-card">
        <div className="admin-card-header">
          <div>
            <strong>Cadastrar número oficial</strong>
            <span>O ID do número vem do cadastro da conta oficial; o telefone é só exibição.</span>
          </div>
        </div>
        <form
          className="admin-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {isSuperadmin ? (
            <label>
              Corretora
              <select value={values.tenantId} onChange={(event) => update('tenantId', event.target.value)} required>
                <option value="">Selecione</option>
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label>
            ID do número
            <input
              value={values.cloudPhoneNumberId}
              onChange={(event) => update('cloudPhoneNumberId', event.target.value.replace(/\D/g, ''))}
              placeholder="Ex.: 1271003609430710"
              inputMode="numeric"
              required
            />
          </label>

          <label>
            Telefone (exibição)
            <input
              value={values.displayPhone}
              onChange={(event) => update('displayPhone', event.target.value)}
              placeholder="(48) 99155-9679"
              inputMode="tel"
            />
          </label>

          {error ? <p className="manual-lead-error">{error}</p> : null}

          <div className="manual-lead-actions">
            <button type="submit" className="panel-refresh" disabled={saving || !values.cloudPhoneNumberId}>
              {saving ? <RefreshCw size={17} /> : <Plus size={17} />}
              Cadastrar número
            </button>
          </div>
        </form>
      </section>

      <div className="panel-surface admin-table-card">
        <div className="admin-card-header">
          <div>
            <strong>Números oficiais</strong>
            <span>{loading ? 'Carregando...' : `${oficiais.length} ativo(s)`}</span>
          </div>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Telefone</th>
              <th>ID do número</th>
              <th>Corretora</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {oficiais.map((item) => (
              <tr key={item.id}>
                <td>{item.ownerPhone ?? '—'}</td>
                <td><code>{item.cloudPhoneNumberId}</code></td>
                <td>{tenantName(item.tenantId)}</td>
                <td><span className="panel-status is-quoted">Ativo</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && oficiais.length === 0 ? (
          <p className="admin-empty">Nenhum número oficial cadastrado ainda.</p>
        ) : null}
        {legado > 0 ? (
          <p className="admin-empty">
            {legado} conexão(ões) antiga(s) por QR desativada(s) — o canal não oficial foi descontinuado.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function PlaceholderSection({ title }: { title: string }): JSX.Element {
  return (
    <section className="panel-surface admin-placeholder">
      <ShieldCheck size={30} />
      <h1>{title}</h1>
      <p>Seção reservada para a próxima camada operacional do Robocote.</p>
    </section>
  );
}

/** Produtos vehicle configuráveis no accordion — mesmo motor Segfy, diferem por vehicle_type. */
interface VehicleRamoDef {
  key: 'auto' | 'moto' | 'caminhao';
  label: string;
  blurb: string;
  icon: typeof Car;
}
const VEHICLE_RAMO_DEFS: VehicleRamoDef[] = [
  { key: 'auto', label: 'Seguro de Carro', blurb: 'Cobertura padrão das cotações de carro.', icon: Car },
  { key: 'moto', label: 'Seguro de Moto', blurb: 'Cobertura padrão das cotações de moto.', icon: Bike },
  { key: 'caminhao', label: 'Seguro de Caminhão', blurb: 'Cobertura padrão das cotações de caminhão.', icon: Truck },
];

/**
 * Item de accordion de um ramo vehicle. Auto-contido: carrega sua própria cobertura
 * (GET /coverage/:ramo) ao montar — assim o badge "Oferecido" aparece já recolhido —
 * e grava via PUT /coverage/:ramo com { coverage, offered }.
 *
 * Toggle "Ofereço este ramo": quando desligado, a corretora não precisa preencher
 * coberturas (Jera) e o robô não oferta esse ramo no atendimento (sai de ramos[]).
 */
function RamoAccordionItem({
  ramo,
  token,
  expanded,
  onToggle,
}: {
  ramo: VehicleRamoDef;
  token: string;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const [coverage, setCoverage] = useState<CoverageAuto>(DEFAULT_COVERAGE_AUTO);
  const [offered, setOffered] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [isNewConfig, setIsNewConfig] = useState(false);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError(null);
    panelFetch(`/api/painel/config/coverage/${ramo.key}`, token)
      .then(async (res) => {
        const body = await res.json().catch(() => ({ ok: false }));
        if (aborted) return;
        if (res.ok && body.ok) {
          setOffered(Boolean(body.offered));
          if (body.coverage) {
            setCoverage({ ...DEFAULT_COVERAGE_AUTO, ...body.coverage });
            setIsNewConfig(false);
          } else {
            setCoverage(DEFAULT_COVERAGE_AUTO);
            setIsNewConfig(true);
          }
        } else {
          setCoverage(DEFAULT_COVERAGE_AUTO);
          setIsNewConfig(true);
        }
      })
      .catch((e: Error) => { if (!aborted) setError(e.message); })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [token, ramo.key]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const res = await panelFetch(`/api/painel/config/coverage/${ramo.key}`, token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coverage, offered }),
      });
      const body = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? 'Falha ao salvar configuração');
      }
      setSavedAt(new Date().toLocaleTimeString('pt-BR'));
      setIsNewConfig(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const Icon = ramo.icon;
  return (
    <div className={`ramo-accordion-item${expanded ? ' expanded' : ''}`}>
      <button type="button" className="ramo-accordion-head" onClick={onToggle}>
        <span className="ramo-accordion-title">
          <Icon size={20} />
          {ramo.label}
        </span>
        <span className="ramo-accordion-meta">
          {loading ? (
            <span className="ramo-badge">…</span>
          ) : (
            <span className={`ramo-badge${offered ? ' on' : ''}`}>{offered ? 'Oferecido' : 'Não oferecido'}</span>
          )}
          <ChevronDown size={18} className="ramo-chevron" />
        </span>
      </button>

      {expanded ? (
        <div className="ramo-accordion-body">
          <label className="ramo-offer-toggle">
            <input type="checkbox" checked={offered} onChange={(e) => setOffered(e.target.checked)} />
            <span>Ofereço este ramo — quando ligado, o robô cota {ramo.label.toLowerCase()} no atendimento.</span>
          </label>

          {error ? <div className="coverage-banner coverage-banner-error">{error}</div> : null}
          {savedAt ? <div className="coverage-banner coverage-banner-success">Salvo às {savedAt}. A próxima cotação já usa esses valores.</div> : null}

          {offered ? (
            <>
              {isNewConfig ? (
                <div className="coverage-banner">
                  Sem cobertura configurada para este ramo — carregamos os padrões Robocote. Ajuste e salve.
                </div>
              ) : null}
              {loading ? (
                <div className="panel-surface">Carregando configuração…</div>
              ) : (
                <div className="panel-surface">
                  <StepCoverageAuto value={coverage} onChange={setCoverage} />
                </div>
              )}
            </>
          ) : (
            <p className="ramo-disabled-hint">
              Este ramo está desligado — não é necessário preencher coberturas. Ligue o toggle acima se quiser que o robô ofereça cotações de {ramo.label.toLowerCase()}.
            </p>
          )}

          <div className="ramo-accordion-actions">
            <button type="button" className="panel-refresh" onClick={() => void save()} disabled={saving || loading}>
              <Save size={17} />
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Item de accordion do ramo Residencial. Mesma mecânica do RamoAccordionItem, mas o
 * motor Segfy é outro (`residence`), então usa o StepCoverageResidencial e o endpoint
 * dedicado /coverage-residencial.
 */
function ResidencialAccordionItem({
  token,
  expanded,
  onToggle,
}: {
  token: string;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const [coverage, setCoverage] = useState<CoverageResidencial>(DEFAULT_COVERAGE_RESIDENCIAL);
  const [offered, setOffered] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [isNewConfig, setIsNewConfig] = useState(false);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError(null);
    panelFetch('/api/painel/config/coverage-residencial', token)
      .then(async (res) => {
        const body = await res.json().catch(() => ({ ok: false }));
        if (aborted) return;
        if (res.ok && body.ok) {
          setOffered(Boolean(body.offered));
          if (body.coverage) {
            setCoverage({ ...DEFAULT_COVERAGE_RESIDENCIAL, ...body.coverage });
            setIsNewConfig(false);
          } else {
            setCoverage(DEFAULT_COVERAGE_RESIDENCIAL);
            setIsNewConfig(true);
          }
        } else {
          setCoverage(DEFAULT_COVERAGE_RESIDENCIAL);
          setIsNewConfig(true);
        }
      })
      .catch((e: Error) => { if (!aborted) setError(e.message); })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [token]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const res = await panelFetch('/api/painel/config/coverage-residencial', token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coverage, offered }),
      });
      const body = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? 'Falha ao salvar configuração');
      }
      setSavedAt(new Date().toLocaleTimeString('pt-BR'));
      setIsNewConfig(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`ramo-accordion-item${expanded ? ' expanded' : ''}`}>
      <button type="button" className="ramo-accordion-head" onClick={onToggle}>
        <span className="ramo-accordion-title">
          <Home size={20} />
          Seguro Residencial
        </span>
        <span className="ramo-accordion-meta">
          {loading ? (
            <span className="ramo-badge">…</span>
          ) : (
            <span className={`ramo-badge${offered ? ' on' : ''}`}>{offered ? 'Oferecido' : 'Não oferecido'}</span>
          )}
          <ChevronDown size={18} className="ramo-chevron" />
        </span>
      </button>

      {expanded ? (
        <div className="ramo-accordion-body">
          <label className="ramo-offer-toggle">
            <input type="checkbox" checked={offered} onChange={(e) => setOffered(e.target.checked)} />
            <span>Ofereço este ramo — quando ligado, o robô cota seguro residencial no atendimento.</span>
          </label>

          {error ? <div className="coverage-banner coverage-banner-error">{error}</div> : null}
          {savedAt ? <div className="coverage-banner coverage-banner-success">Salvo às {savedAt}. A próxima cotação já usa esses valores.</div> : null}

          {offered ? (
            <>
              {isNewConfig ? (
                <div className="coverage-banner">
                  Sem cobertura residencial configurada — carregamos os padrões Robocote. Ajuste e salve.
                </div>
              ) : null}
              {loading ? (
                <div className="panel-surface">Carregando configuração…</div>
              ) : (
                <div className="panel-surface">
                  <StepCoverageResidencial value={coverage} onChange={setCoverage} />
                </div>
              )}
            </>
          ) : (
            <p className="ramo-disabled-hint">
              Este ramo está desligado — não é necessário preencher coberturas. Ligue o toggle acima se quiser que o robô ofereça cotações de seguro residencial.
            </p>
          )}

          <div className="ramo-accordion-actions">
            <button type="button" className="panel-refresh" onClick={() => void save()} disabled={saving || loading}>
              <Save size={17} />
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Seção Configurações — accordion de coberturas por produto (Jera: "abre o formulário
 * descendo, sem mudar de tela; ao clicar em outro, o anterior recolhe").
 * Cada item é uma corretora-config independente; o robô só oferta ramos ligados.
 */
function SettingsSection({ token }: { token: string }): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>('auto');

  return (
    <section className="panel-section-page">
      <header className="panel-hero compact">
        <div>
          <h1>Configurações · Coberturas</h1>
          <p>Configure os padrões de cobertura por produto. Ligue só os ramos que sua corretora oferece — o robô cota apenas o que estiver ligado.</p>
        </div>
      </header>

      <div className="ramo-accordion">
        {VEHICLE_RAMO_DEFS.map((r) => (
          <RamoAccordionItem
            key={r.key}
            ramo={r}
            token={token}
            expanded={expanded === r.key}
            onToggle={() => setExpanded(expanded === r.key ? null : r.key)}
          />
        ))}
        <ResidencialAccordionItem
          token={token}
          expanded={expanded === 'residencial'}
          onToggle={() => setExpanded(expanded === 'residencial' ? null : 'residencial')}
        />
      </div>
    </section>
  );
}

/** Identidade + regras do webchat embutido — espelha WebchatConfig do backend (tenant_configs.config.webchat). */
interface WebchatConfig {
  ativo: boolean;
  avatarUrl: string | null;
  cor: string;
  saudacao: string | null;
  /** Hosts (sem esquema) onde o site da corretora pode embutir o chat. */
  allowedOrigins: string[];
}

interface WebchatConfigResponse {
  ok: true;
  tenantId: string;
  webchat: WebchatConfig;
  agentName: string;
}

interface WebchatInstalacaoResponse {
  ok: true;
  tenantId: string;
  baseUrl: string;
  snippets: { bubble: string; iframe: string };
}

const DEFAULT_WEBCHAT_CONFIG: WebchatConfig = {
  ativo: true,
  avatarUrl: null,
  cor: '#0aa5e8',
  saudacao: null,
  allowedOrigins: [],
};

const WEBCHAT_COR_HEX = /^#[0-9a-f]{6}$/i;
const WEBCHAT_SAUDACAO_MAX = 300;
const WEBCHAT_HOSTS_MAX = 20;

/** O corretor cola "https://site.com.br/pagina"; o backend valida só o host. */
function normalizarHostWebchat(linha: string): string {
  return linha
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '');
}

async function copiarParaAreaDeTransferencia(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    // Sem clipboard assíncrono (http sem TLS, permissão negada): textarea temporário.
    try {
      const area = document.createElement('textarea');
      area.value = texto;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Webchat do site: simulador (iframe da página pública em modo preview) + identidade + código de instalação.
 * Auto-contida como a SettingsSection: faz o próprio GET/PUT, não mexe no estado global do Panel.
 * Superadmin sem tenant escolhe a corretora; impersonando ou admin, o tenant é o da sessão.
 */
function WebchatSection({
  token,
  admin,
  tenants,
}: {
  token: string;
  admin: AdminMeResponse | null;
  tenants: AdminTenant[];
}): JSX.Element {
  const scopedTenantId = admin?.auth.tenantId ?? null;
  const escolheCorretora = (admin?.auth.isSuperadmin ?? false) && !scopedTenantId;
  const [tenantEscolhido, setTenantEscolhido] = useState('');
  const tenantId = scopedTenantId ?? tenantEscolhido;

  useEffect(() => {
    if (escolheCorretora && !tenantEscolhido && tenants[0]) setTenantEscolhido(tenants[0].id);
  }, [escolheCorretora, tenantEscolhido, tenants]);

  const [aba, setAba] = useState<'identidade' | 'instalar'>('identidade');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [agentName, setAgentName] = useState('');
  const [config, setConfig] = useState<WebchatConfig>(DEFAULT_WEBCHAT_CONFIG);
  const [hostsTexto, setHostsTexto] = useState('');
  const [instalacao, setInstalacao] = useState<WebchatInstalacaoResponse | null>(null);
  const [simKey, setSimKey] = useState(0);
  const [copiado, setCopiado] = useState<'bubble' | 'iframe' | null>(null);
  const [avatarQuebrado, setAvatarQuebrado] = useState(false);

  useEffect(() => {
    if (!tenantId) {
      setLoading(false);
      return undefined;
    }
    let aborted = false;
    // Admin/operador: o backend resolve o tenant pela sessão; superadmin sem escopo passa ?tenantId=.
    const query = scopedTenantId ? '' : `?tenantId=${encodeURIComponent(tenantId)}`;
    setLoading(true);
    setError(null);
    setSavedAt(null);
    Promise.all([
      panelFetch(`/api/painel/config/webchat${query}`, token).then((res) =>
        parsePanelResponse<WebchatConfigResponse>(res, 'Não foi possível carregar a identidade do webchat.'),
      ),
      panelFetch(`/api/painel/webchat/instalacao${query}`, token).then((res) =>
        parsePanelResponse<WebchatInstalacaoResponse>(res, 'Não foi possível montar o código de instalação.'),
      ),
    ])
      .then(([cfg, inst]) => {
        if (aborted) return;
        const webchat = { ...DEFAULT_WEBCHAT_CONFIG, ...cfg.webchat };
        setAgentName(cfg.agentName ?? '');
        setConfig(webchat);
        setHostsTexto(webchat.allowedOrigins.join('\n'));
        setInstalacao(inst);
        setAvatarQuebrado(false);
      })
      .catch((e: Error) => {
        if (!aborted) setError(e.message);
      })
      .finally(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [token, tenantId, scopedTenantId]);

  const salvar = async (): Promise<void> => {
    const nome = agentName.trim();
    if (!nome) {
      setError('Informe o nome do agente.');
      return;
    }
    if (!WEBCHAT_COR_HEX.test(config.cor)) {
      setError('Cor inválida — use o formato #1a2b3c.');
      return;
    }
    const hosts = Array.from(new Set(hostsTexto.split('\n').map(normalizarHostWebchat).filter(Boolean)));
    if (hosts.length > WEBCHAT_HOSTS_MAX) {
      setError(`No máximo ${WEBCHAT_HOSTS_MAX} domínios permitidos.`);
      return;
    }
    const saudacao = (config.saudacao ?? '').trim();
    if (saudacao.length > WEBCHAT_SAUDACAO_MAX) {
      setError(`A saudação deve ter no máximo ${WEBCHAT_SAUDACAO_MAX} caracteres.`);
      return;
    }
    const avatarUrl = (config.avatarUrl ?? '').trim();
    if (avatarUrl && !/^https?:\/\//i.test(avatarUrl)) {
      setError('O avatar precisa ser um endereço completo, começando com https://');
      return;
    }
    const payload: WebchatConfig = {
      ativo: config.ativo,
      avatarUrl: avatarUrl || null,
      cor: config.cor.toLowerCase(),
      saudacao: saudacao || null,
      allowedOrigins: hosts,
    };

    setSaving(true);
    setError(null);
    try {
      const res = await panelFetch('/api/painel/config/webchat', token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(scopedTenantId ? {} : { tenantId }), agentName: nome, webchat: payload }),
      });
      await parsePanelResponse<{ ok: true }>(res, 'Não foi possível salvar a identidade do webchat.');
      setConfig(payload);
      setHostsTexto(hosts.join('\n'));
      setAgentName(nome);
      setSavedAt(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
      // O simulador recarrega pra mostrar a identidade recém-salva.
      setSimKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const copiar = async (qual: 'bubble' | 'iframe'): Promise<void> => {
    const texto = instalacao?.snippets[qual];
    if (!texto) return;
    const ok = await copiarParaAreaDeTransferencia(texto);
    if (!ok) {
      setError('Não foi possível copiar — selecione o código e copie manualmente.');
      return;
    }
    setCopiado(qual);
    window.setTimeout(() => setCopiado((atual) => (atual === qual ? null : atual)), 2000);
  };

  const tenant = tenants.find((t) => t.id === tenantId);
  const slug = tenant?.slug ?? tenantId;
  const baseUrl = (instalacao?.baseUrl ?? window.location.origin).replace(/\/$/, '');
  const simUrl = tenantId && instalacao ? `${baseUrl}/webchat?tenant=${encodeURIComponent(slug)}&preview=1` : '';
  const avatarUrl = (config.avatarUrl ?? '').trim();
  const inicial = (agentName.trim().charAt(0) || 'R').toUpperCase();

  return (
    <section className="panel-section-page">
      <header className="panel-hero compact">
        <div>
          <h1>Webchat do site</h1>
          <p>O mesmo agente do WhatsApp, embutido no site da corretora. Ajuste a identidade, teste no simulador e copie o código de instalação.</p>
        </div>
        {escolheCorretora ? (
          <label className="webchat-tenant-pick">
            Corretora
            <select value={tenantEscolhido} onChange={(event) => setTenantEscolhido(event.target.value)}>
              {tenants.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      <div className="webchat-admin-grid">
        <section className="panel-surface admin-create-card webchat-sim">
          <div className="admin-card-header">
            <div>
              <strong>Simulador</strong>
              <span>Exatamente o que o lead vê no site.</span>
            </div>
            <div className="webchat-sim-actions">
              <button type="button" className="panel-refresh" onClick={() => setSimKey((k) => k + 1)} disabled={!simUrl}>
                <RefreshCw size={16} />
                Recarregar
              </button>
              <button
                type="button"
                className="panel-refresh"
                onClick={() => window.open(simUrl, '_blank', 'noopener')}
                disabled={!simUrl}
              >
                <ExternalLink size={16} />
                Abrir em nova aba
              </button>
            </div>
          </div>
          {simUrl ? (
            <iframe key={simKey} className="webchat-sim-frame" src={simUrl} title="Simulador do webchat" />
          ) : (
            <p className="admin-empty">{loading ? 'Carregando simulador…' : 'Selecione uma corretora para simular o atendimento.'}</p>
          )}
          {!config.ativo && !loading ? (
            <p className="admin-empty">Canal desligado — o site da corretora não carrega o chat enquanto ele estiver inativo.</p>
          ) : null}
        </section>

        <section className="panel-surface admin-create-card webchat-config">
          <div className="webchat-tabs" role="tablist" aria-label="Configuração do webchat">
            <button
              type="button"
              role="tab"
              aria-selected={aba === 'identidade'}
              className={aba === 'identidade' ? 'active' : ''}
              onClick={() => setAba('identidade')}
            >
              Identidade
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={aba === 'instalar'}
              className={aba === 'instalar' ? 'active' : ''}
              onClick={() => setAba('instalar')}
            >
              Instalar
            </button>
          </div>

          {aba === 'identidade' ? (
            <form
              className="webchat-form"
              onSubmit={(event) => {
                event.preventDefault();
                void salvar();
              }}
            >
              {error ? <div className="coverage-banner coverage-banner-error">{error}</div> : null}
              {savedAt ? (
                <div className="coverage-banner coverage-banner-success">Salvo às {savedAt}. O simulador já mostra a nova identidade.</div>
              ) : null}

              <label>
                Nome do agente
                <input
                  value={agentName}
                  onChange={(event) => setAgentName(event.target.value)}
                  placeholder="Ex.: Lia"
                  maxLength={60}
                  disabled={loading}
                  required
                />
                <small>Aparece na saudação, no WhatsApp e na sala de cotação.</small>
              </label>

              <div className="webchat-avatar-row">
                <div className="webchat-avatar-preview" style={{ background: WEBCHAT_COR_HEX.test(config.cor) ? config.cor : DEFAULT_WEBCHAT_CONFIG.cor }}>
                  {avatarUrl && !avatarQuebrado ? (
                    <img src={avatarUrl} alt="" onError={() => setAvatarQuebrado(true)} />
                  ) : (
                    <span>{inicial}</span>
                  )}
                </div>
                <label>
                  Avatar (endereço da imagem)
                  <input
                    value={config.avatarUrl ?? ''}
                    onChange={(event) => {
                      setAvatarQuebrado(false);
                      setConfig({ ...config, avatarUrl: event.target.value });
                    }}
                    placeholder="https://…/avatar.png"
                    inputMode="url"
                    disabled={loading}
                  />
                  <small>Quadrada, de preferência 256×256. Sem imagem, mostramos a inicial do nome.</small>
                </label>
              </div>

              <label>
                Cor
                <div className="webchat-color-row">
                  <input
                    type="color"
                    value={WEBCHAT_COR_HEX.test(config.cor) ? config.cor : DEFAULT_WEBCHAT_CONFIG.cor}
                    onChange={(event) => setConfig({ ...config, cor: event.target.value })}
                    disabled={loading}
                    aria-label="Escolher cor"
                  />
                  <input
                    value={config.cor}
                    onChange={(event) => setConfig({ ...config, cor: event.target.value.trim() })}
                    placeholder="#0aa5e8"
                    maxLength={7}
                    disabled={loading}
                  />
                </div>
                <small>Botão flutuante, cabeçalho e balões do agente.</small>
              </label>

              <label>
                Saudação (opcional)
                <textarea
                  value={config.saudacao ?? ''}
                  onChange={(event) => setConfig({ ...config, saudacao: event.target.value })}
                  placeholder="Deixe em branco para usar a saudação padrão do agente."
                  rows={3}
                  maxLength={WEBCHAT_SAUDACAO_MAX}
                  disabled={loading}
                />
                <small>{(config.saudacao ?? '').length}/{WEBCHAT_SAUDACAO_MAX}</small>
              </label>

              <label>
                Domínios permitidos
                <textarea
                  value={hostsTexto}
                  onChange={(event) => setHostsTexto(event.target.value)}
                  placeholder={'www.suacorretora.com.br\nsuacorretora.com.br'}
                  rows={3}
                  disabled={loading}
                  spellCheck={false}
                />
                <small>Um por linha. Vazio = qualquer site pode embutir o chat desta corretora.</small>
              </label>

              <label className="webchat-toggle">
                <input
                  type="checkbox"
                  checked={config.ativo}
                  onChange={(event) => setConfig({ ...config, ativo: event.target.checked })}
                  disabled={loading}
                />
                <span>Webchat ativo — desligado, o botão some do site e a página do chat responde "canal indisponível".</span>
              </label>

              <div className="manual-lead-actions">
                <button type="submit" className="panel-refresh" disabled={saving || loading || !tenantId}>
                  <Save size={17} />
                  {saving ? 'Salvando…' : 'Salvar'}
                </button>
              </div>
            </form>
          ) : (
            <div className="webchat-install">
              {error ? <div className="coverage-banner coverage-banner-error">{error}</div> : null}
              <p className="webchat-install-hint">
                Cole um dos códigos abaixo no site da corretora, <strong>antes do <code>&lt;/body&gt;</code></strong>. O botão flutuante é o jeito recomendado; o iframe serve para uma página de atendimento dedicada.
              </p>

              <div className="webchat-snippet">
                <div className="webchat-snippet-head">
                  <strong>Botão flutuante</strong>
                  <button type="button" className="webchat-copy" onClick={() => void copiar('bubble')} disabled={!instalacao}>
                    {copiado === 'bubble' ? <Check size={15} /> : <Copy size={15} />}
                    {copiado === 'bubble' ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
                <pre>{instalacao?.snippets.bubble ?? (loading ? 'Carregando…' : '—')}</pre>
              </div>

              <div className="webchat-snippet">
                <div className="webchat-snippet-head">
                  <strong>Chat embutido na página (iframe)</strong>
                  <button type="button" className="webchat-copy" onClick={() => void copiar('iframe')} disabled={!instalacao}>
                    {copiado === 'iframe' ? <Check size={15} /> : <Copy size={15} />}
                    {copiado === 'iframe' ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
                <pre>{instalacao?.snippets.iframe ?? (loading ? 'Carregando…' : '—')}</pre>
              </div>

              <p className="webchat-install-hint">
                Se você preencheu os domínios permitidos na aba Identidade, só esses sites conseguem carregar o chat.
              </p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

export function Panel(): JSX.Element {
  const [activeSection, setActiveSection] = useState<PanelSection>('leads');
  const [panelToken] = useState(readStoredPanelToken);
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changePwError, setChangePwError] = useState<string | null>(null);
  const [changePwLoading, setChangePwLoading] = useState(false);
  const [admin, setAdmin] = useState<AdminMeResponse | null>(null);
  const [data, setData] = useState<PanelResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [tenantSaving, setTenantSaving] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [tenantForm, setTenantForm] = useState<TenantForm>({
    documentType: 'cnpj',
    document: '',
    brokerName: '',
    brokerPhone: '',
    managerName: '',
    managerEmail: '',
    managerWhatsapp: '',
    createWhatsapp: true,
  });
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userSaving, setUserSaving] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [userForm, setUserForm] = useState<UserForm>({
    tenantId: '',
    name: '',
    email: '',
    phone: '',
    role: 'operador',
    password: '',
  });
  const [whatsappInstances, setWhatsappInstances] = useState<AdminWhatsappInstance[]>([]);
  const [whatsappLoading, setWhatsappLoading] = useState(false);
  const [whatsappSaving, setWhatsappSaving] = useState(false);
  const [whatsappConnectingName, setWhatsappConnectingName] = useState<string | null>(null);
  const [whatsappError, setWhatsappError] = useState<string | null>(null);
  const [whatsappQr, setWhatsappQr] = useState<{ instanceName: string; qr: EvolutionQrResult } | null>(null);
  const [whatsappForm, setWhatsappForm] = useState<WhatsappForm>({
    tenantId: '',
    cloudPhoneNumberId: '',
    displayPhone: '',
  });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualForm, setManualForm] = useState<ManualLeadForm>({
    name: '',
    phone: '',
    source: '',
    vehicleHint: '',
    notes: '',
  });

  function handleAccessError(e: unknown): boolean {
    if (e instanceof PanelAccessError) {
      setAccessRequired(true);
      setAccessError(e.message);
      return true;
    }
    return false;
  }

  async function refresh(tokenOverride = panelToken): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchPanelLeads(tokenOverride);
      setData(next);
      setSelectedId((current) => {
        if (!current) return null;
        return next.leads.some((lead) => lead.id === current) ? current : null;
      });
    } catch (e) {
      if (handleAccessError(e)) return;
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshAdmin(tokenOverride = panelToken): Promise<void> {
    setAdminError(null);
    try {
      const next = await fetchAdminMe(tokenOverride);
      setAdmin(next);
      setTenants(next.tenants);
    } catch (e) {
      if (handleAccessError(e)) return;
      setAdminError((e as Error).message);
    }
  }

  async function refreshTenants(tokenOverride = panelToken): Promise<void> {
    setTenantsLoading(true);
    setTenantError(null);
    try {
      setTenants(await fetchAdminTenants(tokenOverride));
    } catch (e) {
      if (handleAccessError(e)) return;
      setTenantError((e as Error).message);
    } finally {
      setTenantsLoading(false);
    }
  }

  async function refreshUsers(tokenOverride = panelToken): Promise<void> {
    setUsersLoading(true);
    setUsersError(null);
    try {
      setUsers(await fetchAdminUsers(tokenOverride));
    } catch (e) {
      if (handleAccessError(e)) return;
      setUsersError((e as Error).message);
    } finally {
      setUsersLoading(false);
    }
  }

  async function refreshWhatsapp(tokenOverride = panelToken): Promise<void> {
    setWhatsappLoading(true);
    setWhatsappError(null);
    try {
      setWhatsappInstances(await fetchWhatsappInstances(tokenOverride));
    } catch (e) {
      if (handleAccessError(e)) return;
      setWhatsappError((e as Error).message);
    } finally {
      setWhatsappLoading(false);
    }
  }

  useEffect(() => {
    if (accessRequired) return undefined;

    void refreshAdmin(panelToken);
    void refresh(panelToken);
    const timer = window.setInterval(() => void refresh(panelToken), 10000);
    return () => window.clearInterval(timer);
  }, [accessRequired, panelToken]);

  useEffect(() => {
    if (accessRequired) return;

    if (activeSection === 'tenants') void refreshTenants(panelToken);
    if (activeSection === 'users') void refreshUsers(panelToken);
    if (activeSection === 'whatsapp') void refreshWhatsapp(panelToken);
  }, [accessRequired, activeSection, panelToken]);

  useEffect(() => {
    const fallbackTenant = admin?.auth.tenantId ?? tenants[0]?.id ?? '';
    if (!fallbackTenant) return;
    setUserForm((current) => current.tenantId ? current : { ...current, tenantId: fallbackTenant });
    setWhatsappForm((current) => current.tenantId ? current : { ...current, tenantId: fallbackTenant });
  }, [admin?.auth.tenantId, tenants]);

  const leads = data?.leads ?? [];
  const filteredLeads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return leads.filter((lead) => {
      const text = `${lead.name} ${lead.vehicle} ${lead.channelUser} ${lead.latestMessage ?? ''}`.toLowerCase();
      const searchOk = !normalized || text.includes(normalized);
      return searchOk;
    });
  }, [leads, query]);

  const selectedLead = selectedId ? (leads.find((lead) => lead.id === selectedId) ?? null) : null;
  const metrics = data?.metrics ?? { total: 0, active: 0, ready: 0, quoted: 0, waiting: 0 };
  const panelAuth = admin?.auth ?? data?.auth ?? null;

  async function moveLead(leadId: string, stage: string): Promise<void> {
    const current = data;
    if (!current) return;
    const previous = current.leads.find((lead) => lead.id === leadId);
    if (!previous || previous.stage.key === stage) return;

    const nextLeads = current.leads.map((lead) =>
      lead.id === leadId
        ? {
            ...lead,
            stage: {
              key: stage,
              label: kanbanColumns.find((column) => column.key === stage)?.label ?? lead.stage.label,
            },
          }
        : lead,
    );
    setData({ ...current, leads: nextLeads });

    try {
      const updated = await updateLeadStage(leadId, stage, panelToken);
      setData((latest) => latest
        ? { ...latest, leads: latest.leads.map((lead) => (lead.id === leadId ? updated : lead)) }
        : latest);
    } catch (e) {
      if (handleAccessError(e)) return;
      setError((e as Error).message);
      setData(current);
    }
  }

  async function toggleOverride(leadId: string, active: boolean): Promise<void> {
    try {
      const updated = await setLeadOverride(leadId, active, panelToken);
      setData((latest) => latest
        ? { ...latest, leads: latest.leads.map((lead) => (lead.id === leadId ? updated : lead)) }
        : latest);
    } catch (e) {
      if (handleAccessError(e)) return;
      setError((e as Error).message);
    }
  }

  async function submitManualLead(): Promise<void> {
    setManualSaving(true);
    setManualError(null);
    try {
      const created = await createManualLead(manualForm, panelToken);
      setManualForm({ name: '', phone: '', source: '', vehicleHint: '', notes: '' });
      setManualOpen(false);
      await refresh();
      setSelectedId(created.id);
    } catch (e) {
      if (handleAccessError(e)) return;
      setManualError((e as Error).message);
    } finally {
      setManualSaving(false);
    }
  }

  async function submitTenant(): Promise<void> {
    setTenantSaving(true);
    setTenantError(null);
    try {
      const created = await createAdminTenant(tenantForm, panelToken);
      setTenantForm({
        documentType: 'cnpj',
        document: '',
        brokerName: '',
        brokerPhone: '',
        managerName: '',
        managerEmail: '',
        managerWhatsapp: '',
        createWhatsapp: true,
      });
      if (created.whatsapp?.instance) {
        setWhatsappInstances((current) => [created.whatsapp!.instance, ...current.filter((item) => item.id !== created.whatsapp!.instance.id)]);
      }
      await refreshTenants();
      await refreshAdmin();
      if (activeSection === 'users') await refreshUsers();
      if (activeSection === 'whatsapp') await refreshWhatsapp();
    } catch (e) {
      if (handleAccessError(e)) return;
      setTenantError((e as Error).message);
    } finally {
      setTenantSaving(false);
    }
  }

  async function submitUser(): Promise<void> {
    setUserSaving(true);
    setUsersError(null);
    try {
      const created = await createAdminUser(userForm, panelToken);
      setUsers((current) => [created, ...current.filter((user) => user.id !== created.id)]);
      setUserForm((current) => ({
        tenantId: current.tenantId,
        name: '',
        email: '',
        phone: '',
        role: admin?.auth.isSuperadmin ? current.role : 'operador',
        password: '',
      }));
      await refreshUsers();
    } catch (e) {
      if (handleAccessError(e)) return;
      setUsersError((e as Error).message);
    } finally {
      setUserSaving(false);
    }
  }

  async function submitWhatsapp(): Promise<void> {
    setWhatsappSaving(true);
    setWhatsappError(null);
    try {
      const created = await createWhatsappInstance(whatsappForm, panelToken);
      setWhatsappInstances((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setWhatsappForm((current) => ({
        tenantId: current.tenantId,
        cloudPhoneNumberId: '',
        displayPhone: '',
      }));
      await refreshWhatsapp();
    } catch (e) {
      if (handleAccessError(e)) return;
      setWhatsappError((e as Error).message);
    } finally {
      setWhatsappSaving(false);
    }
  }

  async function connectWhatsapp(instanceName: string): Promise<void> {
    setWhatsappConnectingName(instanceName);
    setWhatsappError(null);
    try {
      const result = await connectWhatsappInstance(instanceName, panelToken);
      setWhatsappQr({ instanceName, qr: result.qr });
      if (result.instance) {
        setWhatsappInstances((current) => current.map((item) => item.evolutionInstanceName === instanceName ? result.instance! : item));
      }
    } catch (e) {
      if (handleAccessError(e)) return;
      setWhatsappError((e as Error).message);
    } finally {
      setWhatsappConnectingName(null);
    }
  }

  async function updateWhatsappState(instanceName: string): Promise<void> {
    setWhatsappConnectingName(instanceName);
    setWhatsappError(null);
    try {
      const instance = await refreshWhatsappState(instanceName, panelToken);
      if (instance) {
        setWhatsappInstances((current) => current.map((item) => item.evolutionInstanceName === instanceName ? instance : item));
      }
    } catch (e) {
      if (handleAccessError(e)) return;
      setWhatsappError((e as Error).message);
    } finally {
      setWhatsappConnectingName(null);
    }
  }

  async function submitLogin(): Promise<void> {
    const email = loginEmail.trim();
    if (!email || !loginPassword) {
      setAccessError('Informe e-mail e senha.');
      return;
    }
    setAccessLoading(true);
    setAccessError(null);
    try {
      await loginRequest(email, loginPassword);
      // Cookie de sessão já setado; bootstrap usa ele automaticamente.
      const [nextAdmin, nextData] = await Promise.all([
        fetchAdminMe(''),
        fetchPanelLeads(''),
      ]);
      setAdmin(nextAdmin);
      setTenants(nextAdmin.tenants);
      setData(nextData);
      setLoginPassword('');
      setAccessRequired(false);
      setAccessError(null);
    } catch (e) {
      setAccessError((e as Error).message);
    } finally {
      setAccessLoading(false);
    }
  }

  async function submitLogout(): Promise<void> {
    await logoutRequest();
    persistPanelToken(''); // limpa também o token dev (fallback) do sessionStorage
    setAdmin(null);
    setData(null);
    setAccessRequired(true);
    setLoginEmail('');
    setLoginPassword('');
  }

  async function submitChangePassword(): Promise<void> {
    if (newPassword.length < 6) {
      setChangePwError('A nova senha precisa ter ao menos 6 caracteres.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangePwError('As senhas não conferem.');
      return;
    }
    setChangePwLoading(true);
    setChangePwError(null);
    try {
      // No primeiro acesso a sessão já autentica — currentPassword não é exigida pelo backend.
      await changePasswordRequest(loginPassword || '', newPassword);
      setNewPassword('');
      setConfirmPassword('');
      setLoginPassword('');
      // Recarrega admin/me (must_change_password agora false) → libera o painel.
      await refreshAdmin('');
    } catch (e) {
      setChangePwError((e as Error).message);
    } finally {
      setChangePwLoading(false);
    }
  }

  async function doImpersonate(tenantId: string): Promise<void> {
    try {
      await impersonateRequest(tenantId);
      await Promise.all([refreshAdmin(''), refresh('')]);
      setActiveSection('leads');
    } catch (e) {
      setAdminError((e as Error).message);
    }
  }

  async function doStopImpersonate(): Promise<void> {
    await stopImpersonateRequest();
    await Promise.all([refreshAdmin(''), refresh('')]);
  }

  if (accessRequired) {
    return (
      <LoginScreen
        email={loginEmail}
        password={loginPassword}
        loading={accessLoading}
        error={accessError}
        onEmailChange={setLoginEmail}
        onPasswordChange={setLoginPassword}
        onSubmit={() => void submitLogin()}
      />
    );
  }

  if (admin?.auth.mustChangePassword) {
    return (
      <ChangePasswordScreen
        newPassword={newPassword}
        confirmPassword={confirmPassword}
        loading={changePwLoading}
        error={changePwError}
        onNewChange={setNewPassword}
        onConfirmChange={setConfirmPassword}
        onSubmit={() => void submitChangePassword()}
      />
    );
  }

  const impersonating = admin?.auth.impersonatingTenantId ?? null;
  const impersonatingName = impersonating
    ? (tenants.find((t) => t.id === impersonating)?.name ?? impersonating)
    : null;

  return (
    <main className="panel-app-shell">
      <PanelSidebar admin={admin} active={activeSection} onSelect={setActiveSection} onLogout={() => void submitLogout()} />
      <section className="panel-shell">
        {impersonating ? (
          <div className="impersonation-banner">
            <span>👁️ Você está vendo o painel de <strong>{impersonatingName}</strong> (modo suporte).</span>
            <button type="button" onClick={() => void doStopImpersonate()}>Sair da visão</button>
          </div>
        ) : null}
        {adminError ? <p className="panel-admin-warning">{adminError}</p> : null}
        {activeSection === 'leads' ? (
          <>
            <section className="panel-hero">
              <div>
                <span>{panelAuth ? roleLabel(panelAuth.role) : 'Operação'}</span>
                <h1>Painel Robocote</h1>
                <p>Leads, conversas e dados estruturados das interações por WhatsApp e IA.</p>
              </div>
              <div className="panel-hero-actions">
                <button type="button" className="panel-add-lead" onClick={() => setManualOpen(true)}>
                  <Plus size={17} />
                  Adicionar novo lead
                </button>
                <button type="button" className="panel-refresh" onClick={() => void refresh()} disabled={loading}>
                  <RefreshCw size={17} />
                  Atualizar
                </button>
              </div>
            </section>

            <section className="panel-metrics" aria-label="Indicadores do atendimento">
              <MetricCard icon={Activity} label="Leads" value={metrics.total} />
              <MetricCard icon={MessageCircle} label="Ativos" value={metrics.active} />
              <MetricCard icon={Clock3} label="Confirmação" value={metrics.waiting} />
              <MetricCard icon={CheckCircle2} label="Cotados" value={metrics.quoted} />
            </section>

            <section className="panel-kanban-shell">
              <div className="panel-surface lead-list-panel">
                <div className="lead-list-toolbar kanban-toolbar">
                  <label className="panel-search">
                    <Search size={16} />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Buscar lead, veículo ou mensagem"
                    />
                  </label>
                </div>

                <div className="kanban-board">
                  {kanbanColumns.map((column) => {
                    const columnLeads = filteredLeads.filter((lead) => lead.stage.key === column.key);
                    return (
                      <section className="kanban-column" key={column.key}>
                        <header>
                          <h2>{column.label}</h2>
                          <span>{columnLeads.length}</span>
                        </header>
                        <div className="kanban-column-list">
                          <div
                            className={`kanban-drop-zone${draggingId ? ' dragging' : ''}`}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => {
                              event.preventDefault();
                              const leadId = event.dataTransfer.getData('text/plain') || draggingId;
                              setDraggingId(null);
                              if (leadId) void moveLead(leadId, column.key);
                            }}
                          >
                            {columnLeads.length > 0 ? (
                              columnLeads.map((lead) => (
                                <div
                                  key={lead.id}
                                  draggable
                                  onDragStart={(event) => {
                                    event.dataTransfer.setData('text/plain', lead.id);
                                    setDraggingId(lead.id);
                                  }}
                                  onDragEnd={() => setDraggingId(null)}
                                >
                                  <LeadCard
                                    lead={lead}
                                    selected={selectedLead?.id === lead.id}
                                    onSelect={() => setSelectedId(lead.id)}
                                  />
                                </div>
                              ))
                            ) : (
                              <div className="kanban-empty">
                                <Car size={22} />
                                <p>{column.key === 'novos_leads' ? (error ?? 'Aguardando leads.') : 'Sem cards.'}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      </section>
                    );
                  })}
                </div>
              </div>
            </section>
          </>
        ) : activeSection === 'conversas' ? (
          <ConversasSection leads={leads} token={panelToken} onRefresh={() => void refresh(panelToken)} />
        ) : activeSection === 'tenants' ? (
          <TenantsSection
            tenants={tenants}
            values={tenantForm}
            saving={tenantSaving}
            loading={tenantsLoading}
            error={tenantError}
            onChange={setTenantForm}
            onSubmit={() => void submitTenant()}
            onRefresh={() => void refreshTenants()}
            onImpersonate={(tenantId) => void doImpersonate(tenantId)}
          />
        ) : activeSection === 'users' ? (
          <UsersSection
            admin={admin}
            tenants={tenants}
            values={userForm}
            users={users}
            loading={usersLoading}
            saving={userSaving}
            error={usersError}
            onChange={setUserForm}
            onSubmit={() => void submitUser()}
            onRefresh={() => void refreshUsers()}
          />
        ) : activeSection === 'whatsapp' ? (
          <WhatsappSection
            admin={admin}
            tenants={tenants}
            values={whatsappForm}
            instances={whatsappInstances}
            loading={whatsappLoading}
            saving={whatsappSaving}
            connectingName={whatsappConnectingName}
            selectedQr={whatsappQr}
            error={whatsappError}
            onChange={setWhatsappForm}
            onSubmit={() => void submitWhatsapp()}
            onConnect={(instanceName) => void connectWhatsapp(instanceName)}
            onState={(instanceName) => void updateWhatsappState(instanceName)}
            onRefresh={() => void refreshWhatsapp()}
          />
        ) : activeSection === 'webchat' ? (
          <WebchatSection token={panelToken} admin={admin} tenants={tenants} />
        ) : activeSection === 'settings' ? (
          <SettingsSection token={panelToken} />
        ) : (
          <PlaceholderSection title="Suporte Robocote" />
        )}
      </section>
      <LeadModal
        lead={selectedLead && selectedId ? selectedLead : null}
        onClose={() => setSelectedId(null)}
        onStageChange={(stage) => {
          if (selectedLead) void moveLead(selectedLead.id, stage);
        }}
        onToggleOverride={(active) => {
          if (selectedLead) void toggleOverride(selectedLead.id, active);
        }}
      />
      <ManualLeadModal
        open={manualOpen}
        values={manualForm}
        saving={manualSaving}
        error={manualError}
        onChange={setManualForm}
        onClose={() => {
          if (!manualSaving) {
            setManualOpen(false);
            setManualError(null);
          }
        }}
        onSubmit={() => void submitManualLead()}
      />
    </main>
  );
}
