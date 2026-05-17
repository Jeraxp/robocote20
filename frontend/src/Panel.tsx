import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  Activity,
  Building2,
  Car,
  CheckCircle2,
  X,
  Clock3,
  ExternalLink,
  LayoutDashboard,
  MessageCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
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
  authMode: 'dev';
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
  connectedAt: string | null;
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

async function createAdminTenant(input: TenantForm, token: string): Promise<AdminTenant> {
  const response = await panelFetch('/api/admin/tenants', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parsePanelResponse<{ ok: true; tenant: AdminTenant }>(response, 'Não foi possível criar a corretora.');
  return body.tenant;
}

async function fetchWhatsappInstances(token: string): Promise<AdminWhatsappInstance[]> {
  const response = await panelFetch('/api/admin/whatsapp-instances', token);
  const body = await parsePanelResponse<{ ok: true; instances: AdminWhatsappInstance[] }>(response, 'Não foi possível carregar WhatsApp.');
  return body.instances;
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

function PanelAccessGate({
  value,
  loading,
  error,
  onChange,
  onSubmit,
}: {
  value: string;
  loading: boolean;
  error: string | null;
  onChange: (value: string) => void;
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
          <h1>Acesso operacional</h1>
          <p>Informe o token do painel para abrir leads, corretoras, usuários e conexões WhatsApp.</p>
        </div>
        <form
          className="panel-access-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label>
            Token do painel
            <input
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder="Cole o token de acesso"
              autoFocus
              type="password"
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
}: {
  lead: PanelLead | null;
  onClose: () => void;
  onStageChange: (stage: string) => void;
}): JSX.Element | null {
  if (!lead) return null;

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
}: {
  admin: AdminMeResponse | null;
  active: PanelSection;
  onSelect: (section: PanelSection) => void;
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
        <small>Auth alpha · escopo por tenant</small>
      </div>
    </aside>
  );
}

function UsersSection({
  users,
  loading,
  error,
  onRefresh,
}: {
  users: AdminUser[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}): JSX.Element {
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

      <div className="panel-surface admin-table-card">
        {error ? <p className="admin-empty">{error}</p> : null}
        <table className="admin-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Email</th>
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
}: {
  tenants: AdminTenant[];
  values: TenantForm;
  saving: boolean;
  loading: boolean;
  error: string | null;
  onChange: (values: TenantForm) => void;
  onSubmit: () => void;
  onRefresh: () => void;
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
  instances,
  loading,
  error,
  onRefresh,
}: {
  instances: AdminWhatsappInstance[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <section className="panel-section-page">
      <header className="panel-hero compact">
        <div>
          <h1>WhatsApp</h1>
          <p>Conexões Evolution API por corretora. O QR Code entra aqui no próximo passo.</p>
        </div>
        <button type="button" className="panel-add-lead" disabled>
          <Plus size={17} />
          Conectar número
        </button>
      </header>

      <div className="panel-surface admin-table-card">
        <div className="admin-card-header">
          <div>
            <strong>Instâncias</strong>
            <span>{loading ? 'Carregando...' : `${instances.length} cadastrada(s)`}</span>
          </div>
          <button type="button" className="panel-refresh" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={17} />
            Atualizar
          </button>
        </div>
        {error ? <p className="admin-empty">{error}</p> : null}
        <table className="admin-table">
          <thead>
            <tr>
              <th>Instância</th>
              <th>Telefone</th>
              <th>Status</th>
              <th>Estado</th>
              <th>Tenant</th>
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

export function Panel(): JSX.Element {
  const [activeSection, setActiveSection] = useState<PanelSection>('leads');
  const [panelToken, setPanelToken] = useState(readStoredPanelToken);
  const [accessInput, setAccessInput] = useState(readStoredPanelToken);
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
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
  });
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [whatsappInstances, setWhatsappInstances] = useState<AdminWhatsappInstance[]>([]);
  const [whatsappLoading, setWhatsappLoading] = useState(false);
  const [whatsappError, setWhatsappError] = useState<string | null>(null);
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
      setAdmin(await fetchAdminMe(tokenOverride));
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
      await createAdminTenant(tenantForm, panelToken);
      setTenantForm({
        documentType: 'cnpj',
        document: '',
        brokerName: '',
        brokerPhone: '',
        managerName: '',
        managerEmail: '',
        managerWhatsapp: '',
      });
      await refreshTenants();
      await refreshAdmin();
      if (activeSection === 'users') await refreshUsers();
    } catch (e) {
      if (handleAccessError(e)) return;
      setTenantError((e as Error).message);
    } finally {
      setTenantSaving(false);
    }
  }

  async function submitPanelToken(): Promise<void> {
    const nextToken = accessInput.trim();
    if (!nextToken) {
      setAccessError('Informe o token para abrir o painel.');
      return;
    }

    setAccessLoading(true);
    setAccessError(null);
    try {
      const [nextAdmin, nextData] = await Promise.all([
        fetchAdminMe(nextToken),
        fetchPanelLeads(nextToken),
      ]);
      persistPanelToken(nextToken);
      setPanelToken(nextToken);
      setAdmin(nextAdmin);
      setData(nextData);
      setAccessRequired(false);
      setAccessError(null);
    } catch (e) {
      if (e instanceof PanelAccessError) {
        setAccessRequired(true);
        setAccessError('Token inválido ou ausente.');
      } else {
        setAccessError((e as Error).message);
      }
    } finally {
      setAccessLoading(false);
    }
  }

  if (accessRequired) {
    return (
      <PanelAccessGate
        value={accessInput}
        loading={accessLoading}
        error={accessError}
        onChange={setAccessInput}
        onSubmit={() => void submitPanelToken()}
      />
    );
  }

  return (
    <main className="panel-app-shell">
      <PanelSidebar admin={admin} active={activeSection} onSelect={setActiveSection} />
      <section className="panel-shell">
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
          />
        ) : activeSection === 'users' ? (
          <UsersSection users={users} loading={usersLoading} error={usersError} onRefresh={() => void refreshUsers()} />
        ) : activeSection === 'whatsapp' ? (
          <WhatsappSection
            instances={whatsappInstances}
            loading={whatsappLoading}
            error={whatsappError}
            onRefresh={() => void refreshWhatsapp()}
          />
        ) : (
          <PlaceholderSection title={activeSection === 'settings' ? 'Configurações' : 'Suporte Robocote'} />
        )}
      </section>
      <LeadModal
        lead={selectedLead && selectedId ? selectedLead : null}
        onClose={() => setSelectedId(null)}
        onStageChange={(stage) => {
          if (selectedLead) void moveLead(selectedLead.id, stage);
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
