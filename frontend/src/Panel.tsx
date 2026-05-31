import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { StepCoverageAuto, DEFAULT_COVERAGE_AUTO } from './StepCoverageAuto';
import { StepCoverageResidencial, DEFAULT_COVERAGE_RESIDENCIAL } from './StepCoverageResidencial';
import type { CoverageAuto, CoverageResidencial } from './types';
import {
  Activity,
  Bike,
  Building2,
  Car,
  CheckCircle2,
  ChevronDown,
  Home,
  X,
  Clock3,
  ExternalLink,
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
  status: string;
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
  instanceName: string;
  ownerPhone: string;
  createInEvolution: boolean;
}

type PanelSection = 'leads' | 'tenants' | 'users' | 'whatsapp' | 'settings' | 'support';

type PanelErrorResponse = { ok: false; error?: string; authRequired?: boolean };

const kanbanColumns = [
  { key: 'novos_leads', label: 'Novos Leads' },
  { key: 'contatados', label: 'Contatados' },
  { key: 'em_negociacao', label: 'Em Negociação' },
  { key: 'sem_retorno', label: 'Sem Retorno' },
  { key: 'vendas', label: 'Vendas' },
  { key: 'perdido', label: 'Perdido' },
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
  tenants: Building2,
  users: UsersRound,
  whatsapp: Smartphone,
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
    { key: 'tenants' as const, label: 'Corretoras', enabled: false },
    { key: 'users' as const, label: 'Usuários', enabled: false },
    { key: 'whatsapp' as const, label: 'WhatsApp', enabled: false },
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
  connectingName,
  selectedQr,
  error,
  onChange,
  onSubmit,
  onConnect,
  onState,
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
  const update = (key: keyof WhatsappForm, value: string | boolean): void => {
    onChange({ ...values, [key]: value });
  };
  const qrSrc = selectedQr?.qr.base64?.startsWith('data:')
    ? selectedQr.qr.base64
    : selectedQr?.qr.base64
      ? `data:image/png;base64,${selectedQr.qr.base64}`
      : null;

  return (
    <section className="panel-section-page">
      <header className="panel-hero compact">
        <div>
          <h1>WhatsApp</h1>
          <p>Conexões Evolution API por corretora, com QR Code gerado dentro do Robocote.</p>
        </div>
        <button type="button" className="panel-refresh" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={17} />
          Atualizar
        </button>
      </header>

      <section className="panel-surface admin-create-card">
        <div className="admin-card-header">
          <div>
            <strong>Nova conexão</strong>
            <span>Use para criar uma instância manual ou refazer onboarding de uma corretora.</span>
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
            Instância
            <input
              value={values.instanceName}
              onChange={(event) => update('instanceName', event.target.value)}
              placeholder="Ex.: robocote-protecta"
            />
          </label>

          <label>
            Telefone dono
            <input
              value={values.ownerPhone}
              onChange={(event) => update('ownerPhone', event.target.value)}
              placeholder="(11) 99999-9999"
              inputMode="tel"
            />
          </label>

          <label className="admin-checkbox-field">
            <input
              type="checkbox"
              checked={values.createInEvolution}
              onChange={(event) => update('createInEvolution', event.target.checked)}
            />
            Criar também na Evolution
          </label>

          {error ? <p className="manual-lead-error">{error}</p> : null}

          <div className="manual-lead-actions">
            <button type="submit" className="panel-refresh" disabled={saving}>
              {saving ? <RefreshCw size={17} /> : <Plus size={17} />}
              Criar conexão
            </button>
          </div>
        </form>
      </section>

      {selectedQr ? (
        <section className="panel-surface whatsapp-qr-card">
          <div>
            <span>QR Code</span>
            <h2>{selectedQr.instanceName}</h2>
            <p>Escaneie no WhatsApp do cliente para conectar a instância.</p>
            {selectedQr.qr.pairingCode || selectedQr.qr.code ? (
              <strong>{selectedQr.qr.pairingCode ?? selectedQr.qr.code}</strong>
            ) : null}
          </div>
          {qrSrc ? <img src={qrSrc} alt={`QR Code ${selectedQr.instanceName}`} /> : <QrCode size={86} />}
        </section>
      ) : null}

      <div className="panel-surface admin-table-card">
        <div className="admin-card-header">
          <div>
            <strong>Instâncias</strong>
            <span>{loading ? 'Carregando...' : `${instances.length} cadastrada(s)`}</span>
          </div>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Instância</th>
              <th>Telefone</th>
              <th>Status</th>
              <th>Estado</th>
              <th>Tenant</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {instances.map((item) => (
              <tr key={item.id}>
                <td>{item.evolutionInstanceName}</td>
                <td>{item.ownerPhone ?? 'A definir'}</td>
                <td>{item.status}</td>
                <td>{item.lastConnectionState ?? 'Sem leitura'}</td>
                <td>{item.tenantId}</td>
                <td>
                  <div className="admin-table-actions">
                    <button
                      type="button"
                      className="admin-icon-button"
                      onClick={() => onConnect(item.evolutionInstanceName)}
                      disabled={connectingName === item.evolutionInstanceName}
                      title="Gerar QR Code"
                    >
                      {connectingName === item.evolutionInstanceName ? <RefreshCw size={15} /> : <QrCode size={15} />}
                    </button>
                    <button
                      type="button"
                      className="admin-icon-button"
                      onClick={() => onState(item.evolutionInstanceName)}
                      disabled={connectingName === item.evolutionInstanceName}
                      title="Atualizar estado"
                    >
                      <RefreshCw size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && instances.length === 0 ? (
          <p className="admin-empty">Nenhum WhatsApp conectado ainda. A fundação de QR já está no backend.</p>
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
    instanceName: '',
    ownerPhone: '',
    createInEvolution: true,
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
        instanceName: '',
        ownerPhone: '',
        createInEvolution: true,
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
