import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  Activity,
  Car,
  CheckCircle2,
  X,
  Clock3,
  ExternalLink,
  MessageCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  UserRound,
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

interface ManualLeadForm {
  name: string;
  phone: string;
  source: string;
  vehicleHint: string;
  notes: string;
}

const kanbanColumns = [
  { key: 'novos_leads', label: 'Novos Leads' },
  { key: 'contatados', label: 'Contatados' },
  { key: 'em_negociacao', label: 'Em Negociação' },
  { key: 'sem_retorno', label: 'Sem Retorno' },
  { key: 'vendas', label: 'Vendas' },
  { key: 'perdido', label: 'Perdido' },
];

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

async function fetchPanelLeads(): Promise<PanelResponse> {
  const response = await fetch('/api/painel/leads');
  const body = (await response.json()) as PanelResponse | { ok: false; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error('error' in body && body.error ? body.error : 'Não foi possível carregar o painel.');
  }
  return body;
}

async function updateLeadStage(leadId: string, stage: string): Promise<PanelLead> {
  const response = await fetch(`/api/painel/leads/${encodeURIComponent(leadId)}/stage`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage }),
  });
  const body = (await response.json()) as { ok: true; lead: PanelLead } | { ok: false; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error('error' in body && body.error ? body.error : 'Não foi possível mover o lead.');
  }
  return body.lead;
}

async function createManualLead(input: ManualLeadForm): Promise<PanelLead> {
  const response = await fetch('/api/painel/leads/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as { ok: true; lead: PanelLead } | { ok: false; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error('error' in body && body.error ? body.error : 'Não foi possível cadastrar o lead.');
  }
  return body.lead;
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
                <span>{item.direction === 'inbound' ? 'Lead' : item.direction === 'outbound' ? 'Vivi' : 'Sistema'}</span>
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

export function Panel(): JSX.Element {
  const [data, setData] = useState<PanelResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchPanelLeads();
      setData(next);
      setSelectedId((current) => {
        if (!current) return null;
        return next.leads.some((lead) => lead.id === current) ? current : null;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, []);

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
      const updated = await updateLeadStage(leadId, stage);
      setData((latest) => latest
        ? { ...latest, leads: latest.leads.map((lead) => (lead.id === leadId ? updated : lead)) }
        : latest);
    } catch (e) {
      setError((e as Error).message);
      setData(current);
    }
  }

  async function submitManualLead(): Promise<void> {
    setManualSaving(true);
    setManualError(null);
    try {
      const created = await createManualLead(manualForm);
      setManualForm({ name: '', phone: '', source: '', vehicleHint: '', notes: '' });
      setManualOpen(false);
      await refresh();
      setSelectedId(created.id);
    } catch (e) {
      setManualError((e as Error).message);
    } finally {
      setManualSaving(false);
    }
  }

  return (
    <main className="panel-shell">
      <section className="panel-hero">
        <div>
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
