import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  AlertTriangle,
  BadgeDollarSign,
  Car,
  CheckCircle2,
  ChevronRight,
  FileText,
  LockKeyhole,
  MessageCircle,
  RefreshCw,
  Scale,
  ShieldCheck,
  Sparkles,
  Star,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CoveragePreference, QuoteCustomerInfo, QuoteOptionSummary, QuoteRecommendation, QuoteSummary } from './types';
import { DeterministicChat } from './DeterministicChat';
import robocoteLogo from './assets/logo_robocote.png';

const DEMO_GUID = 'a6c2c899-0fb3-4cc4-81a3-ed8cc6742ea7';

// Número do WhatsApp do corretor/Robocote pra handoff via wa.me.
// Em produção, virá do backend via /api/jornadas/auto/f1. Hoje é constante pro spike.
const ROBOCOTE_WA_NUMBER = '5511999999999';

function buildInterestMessage(option: QuoteOptionSummary, customer: QuoteCustomerInfo, summary: QuoteSummary): string {
  const greeting = customer.firstName ? `Olá! Sou ${customer.firstName}` : 'Olá!';
  const vehicle = summary.vehicle.label || 'meu veículo';
  const price = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(option.annualPremium);
  return `${greeting} e quero seguir com a cotação do ${vehicle} — escolhi ${option.productName} (${option.insurerName}), prêmio anual ${price}. Cotação: ${summary.guid.slice(0, 8)}.`;
}

function buildGeneralMessage(customer: QuoteCustomerInfo, summary: QuoteSummary): string {
  const greeting = customer.firstName ? `Olá! Sou ${customer.firstName}` : 'Olá!';
  const vehicle = summary.vehicle.label || 'meu veículo';
  return `${greeting} e quero conversar sobre a cotação do ${vehicle}. Cotação: ${summary.guid.slice(0, 8)}.`;
}

function waLink(message: string): string {
  return `https://wa.me/${ROBOCOTE_WA_NUMBER}?text=${encodeURIComponent(message)}`;
}

function coverageLineIsHidden(value: string | null | undefined): boolean {
  if (!value) return true;
  const normalized = value.toLowerCase();
  return normalized.includes('não contratad') ||
    normalized.includes('nao contratad') ||
    normalized === 'não informado' ||
    normalized === 'nao informado';
}

function preferenceLabel(preference: CoveragePreference): string {
  if (!preference) return 'Equilíbrio';
  return preference;
}

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 2,
});

const integerCurrency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const recommendationMeta: Record<
  QuoteRecommendation['role'],
  { icon: LucideIcon; tone: string; eyebrow: string }
> = {
  cheap: { icon: BadgeDollarSign, tone: 'green', eyebrow: 'Economia' },
  balanced: { icon: Scale, tone: 'orange', eyebrow: 'Equilíbrio' },
  complete: { icon: ShieldCheck, tone: 'blue', eyebrow: 'Proteção' },
};

function getInitialGuid(): string {
  const params = new URLSearchParams(window.location.search);
  const queryGuid = params.get('guid');
  if (queryGuid) return queryGuid;

  const lastPathPart = window.location.pathname.split('/').filter(Boolean).at(-1);
  if (lastPathPart && lastPathPart !== 'quote-room' && lastPathPart !== 'index.html') {
    return lastPathPart;
  }

  return DEMO_GUID;
}

function getInitialMode(): 'quote-room' | 'webchat' {
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'webchat') return 'webchat';
  if (window.location.pathname.includes('/webchat')) return 'webchat';
  if (params.get('mode') === 'quote-room') return 'quote-room';
  if (params.get('guid')) return 'quote-room';
  if (window.location.pathname.includes('/quote-room')) return 'quote-room';
  return 'webchat';
}

function formatDate(value: string | null): string {
  if (!value) return 'Em validação';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return dateFormatter.format(date);
}

function formatMoney(value: number | null): string {
  if (typeof value !== 'number') return 'A validar';
  return currency.format(value);
}

function formatIntegerMoney(value: number | null): string {
  if (typeof value !== 'number') return 'A validar';
  return integerCurrency.format(value);
}

function findOption(summary: QuoteSummary, optionId: string): QuoteOptionSummary {
  return summary.options.find((option) => option.id === optionId) ?? summary.options[0];
}

async function fetchQuoteSummary(guid: string): Promise<QuoteSummary> {
  const response = await fetch(`/api/cotacoes/${encodeURIComponent(guid)}/resumo`);
  const body = (await response.json()) as QuoteSummary | { ok: false; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error('error' in body && body.error ? body.error : 'Não foi possível carregar a cotação.');
  }
  return body;
}

function AppHeader({ status = 'Cotação validada pela Segfy' }: { status?: string }): JSX.Element {
  return (
    <header className="app-header">
      <div className="brand-mark" aria-label="Robocote">
        <img className="brand-logo" src={robocoteLogo} alt="robocote - cote seu seguro" />
      </div>
      <div className="header-status">
        <CheckCircle2 size={18} />
        <span>{status}</span>
      </div>
      <nav className="header-actions" aria-label="Ações rápidas">
        <div className="secure-pill">
          <LockKeyhole size={17} />
          Ambiente seguro
        </div>
        <button type="button" className="contact-button">
          <MessageCircle size={18} />
          Contato
        </button>
      </nav>
    </header>
  );
}

function LoadingState(): JSX.Element {
  return (
    <main className="page-shell loading-shell">
      <section className="loading-panel">
        <div className="loader-ring" />
        <h1>Preparando sua cotação auto</h1>
        <p>Organizando opções, coberturas e franquias em uma visão consultiva.</p>
      </section>
    </main>
  );
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }): JSX.Element {
  return (
    <main className="page-shell loading-shell">
      <section className="error-panel">
        <AlertTriangle size={36} />
        <h1>Não conseguimos abrir esta cotação</h1>
        <p>{error}</p>
        <button type="button" className="primary-button" onClick={onRetry}>
          <RefreshCw size={17} />
          Tentar novamente
        </button>
      </section>
    </main>
  );
}

function VehicleCard({ summary }: { summary: QuoteSummary }): JSX.Element {
  return (
    <section className="vehicle-card" aria-label="Resumo do veículo">
      <Car size={38} />
      <div>
        <h2>{summary.vehicle.label}</h2>
        <p>{summary.vehicle.model || 'Modelo em validação'}</p>
        <span>FIPE {summary.vehicle.fipeCode || 'em análise'}</span>
      </div>
    </section>
  );
}

function RecommendationStrip({
  summary,
  activeRole,
  onSelectRole,
}: {
  summary: QuoteSummary;
  activeRole: QuoteRecommendation['role'];
  onSelectRole: (role: QuoteRecommendation['role']) => void;
}): JSX.Element {
  return (
    <section className="recommendation-strip" aria-label="Recomendações Robocote">
      <div className="section-heading">
        <Sparkles size={19} />
        <div>
          <h2>Recomendação Robocote</h2>
          <p>Escolha a lente de decisão para comparar as melhores opções.</p>
        </div>
      </div>
      <div className="recommendation-grid">
        {summary.recommendations.map((recommendation) => {
          const option = findOption(summary, recommendation.optionId);
          const meta = recommendationMeta[recommendation.role];
          const Icon = meta.icon;
          const selected = activeRole === recommendation.role;
          return (
            <button
              type="button"
              key={recommendation.role}
              className={`recommendation-card tone-${meta.tone}${selected ? ' is-selected' : ''}`}
              onClick={() => onSelectRole(recommendation.role)}
            >
              <span className="radio-dot" aria-hidden="true" />
              <span className="mini-label">{meta.eyebrow}</span>
              <Icon size={30} />
              <strong>{recommendation.title}</strong>
              <small>{option.productName}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CompanyBadge({ insurerKey, insurerName }: { insurerKey: string; insurerName: string }): JSX.Element {
  return (
    <div className={`company-badge company-${insurerKey || 'default'}`}>
      <span>{insurerName.slice(0, 1)}</span>
      <strong>{insurerName}</strong>
    </div>
  );
}

function QuoteCard({
  option,
  selected,
  onSelect,
  interestHref,
}: {
  option: QuoteOptionSummary;
  selected: boolean;
  onSelect: (id: string) => void;
  interestHref: string;
}): JSX.Element {
  return (
    <article className={`quote-card${selected ? ' selected' : ''}`}>
      <div className="quote-rank">{option.rank}º</div>
      <CompanyBadge insurerKey={option.insurerKey} insurerName={option.insurerName} />
      <h3>{option.productName}</h3>
      <div className="quote-price">
        <span>{formatMoney(option.annualPremium)}</span>
        <small>{option.paymentSummary}</small>
      </div>
      <dl className="quote-facts">
        <div>
          <dt>Franquia</dt>
          <dd>{formatIntegerMoney(option.franchise)}</dd>
        </div>
        <div>
          <dt>FIPE</dt>
          <dd>{option.coverage.fipePercentage ? `${option.coverage.fipePercentage}%` : 'A validar'}</dd>
        </div>
      </dl>
      <p className="quote-note">{option.consultativeNote}</p>
      <div className="badge-row">
        {option.badges.map((badge) => (
          <span key={badge}>{badge}</span>
        ))}
      </div>
      <div className="quote-card-actions">
        <button type="button" className="outline-button" onClick={() => onSelect(option.id)}>
          Ver detalhes
          <ChevronRight size={16} />
        </button>
        <a className="primary-action" href={interestHref} target="_blank" rel="noreferrer">
          <MessageCircle size={16} />
          Tenho interesse
        </a>
      </div>
    </article>
  );
}

function QuoteGrid({
  options,
  selectedOptionId,
  onSelect,
  buildInterestHref,
}: {
  options: QuoteOptionSummary[];
  selectedOptionId: string;
  onSelect: (id: string) => void;
  buildInterestHref: (option: QuoteOptionSummary) => string;
}): JSX.Element {
  return (
    <section className="quote-grid-section" aria-label="Opções ranqueadas">
      <div className="quote-grid">
        {options.map((option) => (
          <QuoteCard
            key={option.id}
            option={option}
            selected={selectedOptionId === option.id}
            onSelect={onSelect}
            interestHref={buildInterestHref(option)}
          />
        ))}
      </div>
    </section>
  );
}

function ComparisonTable({ options }: { options: QuoteOptionSummary[] }): JSX.Element {
  const rows = [
    {
      label: 'Preço anual',
      icon: BadgeDollarSign,
      value: (option: QuoteOptionSummary) => formatMoney(option.annualPremium),
    },
    {
      label: 'Franquia geral',
      icon: Wrench,
      value: (option: QuoteOptionSummary) => formatIntegerMoney(option.franchise),
    },
    {
      label: 'Cobertura',
      icon: ShieldCheck,
      value: (option: QuoteOptionSummary) => option.coverage.coverageType,
    },
    {
      label: 'Percentual FIPE',
      icon: Star,
      value: (option: QuoteOptionSummary) =>
        option.coverage.fipePercentage ? `${option.coverage.fipePercentage}% FIPE` : 'A validar',
    },
    {
      label: 'Danos materiais',
      icon: FileText,
      value: (option: QuoteOptionSummary) => formatIntegerMoney(option.coverage.materialDamage),
    },
    {
      label: 'Danos corporais',
      icon: FileText,
      value: (option: QuoteOptionSummary) => formatIntegerMoney(option.coverage.bodyInjuries),
    },
    {
      label: 'Assistência',
      icon: Wrench,
      value: (option: QuoteOptionSummary) => option.coverage.assistance,
    },
    {
      label: 'Vidros',
      icon: ShieldCheck,
      value: (option: QuoteOptionSummary) => option.coverage.glass,
    },
  ];

  return (
    <section className="comparison-section" aria-label="Comparativo de coberturas">
      <div className="comparison-title">
        <h2>Compare as coberturas</h2>
        <span>{options.length} opções principais</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Coberturas</th>
              {options.map((option) => (
                <th scope="col" key={option.id}>
                  {option.productName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const Icon = row.icon;
              return (
                <tr key={row.label}>
                  <th scope="row">
                    <Icon size={16} />
                    {row.label}
                  </th>
                  {options.map((option) => (
                    <td key={`${row.label}-${option.id}`}>{row.value(option)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OptionDetails({ option }: { option: QuoteOptionSummary }): JSX.Element {
  const attention =
    option.attentionPoints.length > 0 ? (
      <ul className="attention-list">
        {option.attentionPoints.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    ) : (
      <p className="clean-state">Sem pontos críticos para esta primeira leitura.</p>
    );

  const coverageLines = [option.coverage.assistance, option.coverage.glass, option.coverage.rentalCar]
    .filter((line) => !coverageLineIsHidden(line));

  return (
    <section className="detail-panel" aria-label="Detalhes da opção selecionada">
      <div className="detail-header">
        <CompanyBadge insurerKey={option.insurerKey} insurerName={option.insurerName} />
        <h2>{option.productName}</h2>
        <p>{option.consultativeNote}</p>
      </div>
      <div className="detail-metrics">
        <div>
          <span>Prêmio anual</span>
          <strong>{formatMoney(option.annualPremium)}</strong>
        </div>
        <div>
          <span>Franquia</span>
          <strong>{formatIntegerMoney(option.franchise)}</strong>
        </div>
        <div>
          <span>Score Robocote</span>
          <strong>{option.scores.balance}/100</strong>
          <small className="score-legend">Considera preço, cobertura, franquia e assistência. Acima de 40 já é equilibrado.</small>
        </div>
      </div>
      {coverageLines.length > 0 ? (
        <div className="coverage-list">
          {coverageLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
      <div className="attention-box">
        <h3>Pontos de atenção</h3>
        {attention}
      </div>
    </section>
  );
}

function AdvisorPanel({
  summary,
  selectedRecommendation,
  selectedOption,
  generalWaHref,
}: {
  summary: QuoteSummary;
  selectedRecommendation: QuoteRecommendation;
  selectedOption: QuoteOptionSummary;
  generalWaHref: string;
}): JSX.Element {
  const insightIcons = [CheckCircle2, ShieldCheck, Wrench];
  const insightTitles = ['Recomendação consultiva', 'Protege o que importa', 'Assistência em foco'];
  const bullets = summary.advisor.bullets.slice(0, insightIcons.length);

  return (
    <aside className="advisor-panel" aria-label="Painel consultivo">
      <section className="advisor-card recommendation-focus">
        <div className="advisor-title">
          <Star size={21} />
          <span>Recomendação Robocote</span>
        </div>
        <h2>{selectedRecommendation.title}</h2>
        <p>{selectedRecommendation.reason}</p>
        <strong>{selectedOption.productName}</strong>
        <small className="advisor-personal">{summary.advisor.summary}</small>
      </section>

      <section className="advisor-card insight-list">
        {bullets.map((bullet, index) => {
          const Icon = insightIcons[index] ?? CheckCircle2;
          const title = insightTitles[index] ?? 'Robocote';
          return (
            <div className="insight-item" key={bullet.slice(0, 24)}>
              <Icon size={28} />
              <div>
                <strong>{title}</strong>
                <p>{bullet}</p>
              </div>
            </div>
          );
        })}
        <div className="insight-item">
          <LockKeyhole size={28} />
          <div>
            <strong>Dados protegidos</strong>
            <p>Esta sala usa resumo seguro, sem CPF, placa ou credenciais.</p>
          </div>
        </div>
      </section>

      <section className="advisor-card whatsapp-card">
        <span>Precisa de ajuda?</span>
        <p>Fale com seu corretor para avançar com a opção escolhida.</p>
        <a href={generalWaHref} target="_blank" rel="noreferrer" className="whatsapp-button">
          <MessageCircle size={18} />
          Falar no WhatsApp
        </a>
      </section>
    </aside>
  );
}

function AdditionalProducts({ options }: { options: QuoteOptionSummary[] }): JSX.Element {
  if (options.length === 0) {
    return <></>;
  }

  return (
    <section className="additional-section" aria-label="Produtos adicionais">
      <div className="comparison-title">
        <h2>Alternativas econômicas</h2>
        <span>{options.length} produtos adicionais</span>
      </div>
      <div className="additional-list">
        {options.map((option) => (
          <article key={option.id}>
            <div>
              <strong>{option.productName}</strong>
              <p>{option.coverage.coverageType}</p>
            </div>
            <span>{formatMoney(option.annualPremium)}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function QuoteRoom({ summary }: { summary: QuoteSummary }): JSX.Element {
  const [activeRole, setActiveRole] = useState<QuoteRecommendation['role']>(() => {
    if (summary.customer.coveragePreference === 'Economia') return 'cheap';
    if (summary.customer.coveragePreference === 'Proteção') return 'complete';
    return 'balanced';
  });
  const [selectedOptionId, setSelectedOptionId] = useState(
    summary.recommendations.find((item) => item.role === activeRole)?.optionId ?? summary.options[0].id,
  );

  useEffect(() => {
    setSelectedOptionId(
      summary.recommendations.find((item) => item.role === activeRole)?.optionId ?? summary.options[0].id,
    );
  }, [activeRole, summary]);

  const primaryOptions = useMemo(
    () => summary.options.filter((option) => option.category === 'principal'),
    [summary.options],
  );
  const additionalOptions = useMemo(
    () => summary.options.filter((option) => option.category === 'adicional'),
    [summary.options],
  );
  const selectedRecommendation =
    summary.recommendations.find((recommendation) => recommendation.role === activeRole) ?? summary.recommendations[0];
  const selectedOption = findOption(summary, selectedOptionId);

  const buildInterestHref = (option: QuoteOptionSummary): string =>
    waLink(buildInterestMessage(option, summary.customer, summary));
  const generalWaHref = waLink(buildGeneralMessage(summary.customer, summary));

  const firstName = summary.customer.firstName?.trim();
  const heroTitle = firstName ? `Olá, ${firstName}! Sua sala Robocote` : 'Sua sala Robocote';
  const heroSubtitle = firstName
    ? `Separei as melhores opções pra você com prioridade em ${preferenceLabel(summary.customer.coveragePreference)}.`
    : 'Confira as melhores opções para o seu perfil.';

  return (
    <main className="page-shell">
      <section className="hero-row">
        <div className="title-block">
          <span>Sua cotação</span>
          <h1>{heroTitle}</h1>
          <p>{heroSubtitle}</p>
        </div>
        <VehicleCard summary={summary} />
      </section>

      <div className="content-layout">
        <div className="main-column">
          <RecommendationStrip summary={summary} activeRole={activeRole} onSelectRole={setActiveRole} />
          <QuoteGrid
            options={primaryOptions}
            selectedOptionId={selectedOptionId}
            onSelect={setSelectedOptionId}
            buildInterestHref={buildInterestHref}
          />
          <ComparisonTable options={primaryOptions} />
          <OptionDetails option={selectedOption} />
          <AdditionalProducts options={additionalOptions} />
          <p className="legal-note">
            Valores sujeitos à validação final da seguradora. Cotação {summary.quotationId.slice(0, 8)} emitida em{' '}
            {formatDate(summary.quoteDate)} e válida até {formatDate(summary.validUntil)}.
          </p>
        </div>
        <AdvisorPanel
          summary={summary}
          selectedRecommendation={selectedRecommendation}
          selectedOption={selectedOption}
          generalWaHref={generalWaHref}
        />
      </div>
    </main>
  );
}

export function App(): JSX.Element {
  const [mode] = useState(getInitialMode);
  const [guid] = useState(getInitialGuid);
  const [summary, setSummary] = useState<QuoteSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (mode !== 'quote-room') return undefined;
    const abort = new AbortController();
    setError(null);
    setSummary(null);

    fetchQuoteSummary(guid)
      .then((nextSummary) => {
        if (!abort.signal.aborted) setSummary(nextSummary);
      })
      .catch((e: Error) => {
        if (!abort.signal.aborted) setError(e.message);
      });

    return () => abort.abort();
  }, [guid, mode, retryKey]);

  if (mode === 'webchat') {
    return (
      <>
        <AppHeader status="Jornada determinística F1" />
        <DeterministicChat />
      </>
    );
  }

  return (
    <>
      <AppHeader />
      {summary ? (
        <QuoteRoom summary={summary} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => setRetryKey((value) => value + 1)} />
      ) : (
        <LoadingState />
      )}
      <button type="button" className="floating-chat-button" aria-label="Abrir contato Robocote">
        <MessageCircle size={24} />
      </button>
    </>
  );
}
