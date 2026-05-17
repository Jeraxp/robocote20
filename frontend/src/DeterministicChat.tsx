import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  ArrowRight,
  Bot,
  Car,
  CheckCircle2,
  ClipboardCheck,
  MessageCircle,
  RefreshCw,
  Route,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import robocoteLogo from './assets/logo_robocote.png';
import type { CatalogBrand, CatalogModel, QuoteSummary } from './types';
import {
  FLOW_STEPS,
  INITIAL_MESSAGES,
  FLOW_ORDER,
  answerPayloadValue,
  buildAnswer,
  buildBotFollowUp,
  buildWhatsappPreview,
  getNextStepId,
  getVisibleSteps,
  validateStepValue,
  type ActiveFlowStepId,
  type ChatMessage,
  type FlowAnswer,
  type FlowStepId,
} from './chatFlow';

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 2,
});

interface JourneyContract {
  ok: true;
  quoteRoomPath: string;
}

interface AutoF1QuoteResponse {
  ok: true;
  guid: string;
  callbackId: string;
  quoteRoomPath: string;
  quoteSummary: QuoteSummary;
  calculateStatus: string;
  events: {
    total: number;
    result: number;
    pdf: number;
    step: number;
    timedOut: boolean;
  };
  elapsedMs: number;
}

interface QuoteRunState {
  status: 'idle' | 'running' | 'ready' | 'error';
  error?: string;
  guid?: string;
  callbackId?: string;
  events?: AutoF1QuoteResponse['events'];
  elapsedMs?: number;
}

interface AssistantCatalogItem {
  id: string;
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

type AssistantChannel = 'webchat' | 'whatsapp';

interface AssistantMessageResponse {
  ok: true;
  source: 'taskdun-ai' | 'local-rules';
  configured: boolean;
  mode: 'capture' | 'consult';
  action: 'answer_step' | 'ask_clarification' | 'consult_reply' | 'calculate' | 'none';
  stepId: ActiveFlowStepId;
  channel: AssistantChannel;
  reply: string;
  proposedAnswer?: {
    stepId: ActiveFlowStepId;
    value: string;
    displayLabel?: string;
    metadata?: Record<string, unknown>;
    confidence: number;
  };
}

async function fetchJourneyContract(): Promise<JourneyContract> {
  const response = await fetch('/api/jornadas/auto/f1');
  const body = (await response.json()) as JourneyContract | { ok: false; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error('Não foi possível carregar a jornada determinística.');
  }
  return body;
}

async function postAutoF1Quote(
  answers: Partial<Record<FlowStepId, FlowAnswer>>,
): Promise<AutoF1QuoteResponse> {
  // Metadata do modelo carrega FIPE real e fuel_type vindos da NJ no autocomplete.
  const modelMetadata = (answers.vehicle_model?.metadata ?? {}) as {
    fipe_code?: string;
    fipe_value?: number;
    model_id?: string;
    fuel_type?: string;
  };
  // Metadata da marca pode carregar o text humano (rawValue é o UUID).
  const brandMetadata = (answers.vehicle_brand?.metadata ?? {}) as { brand_text?: string };

  const response = await fetch('/api/jornadas/auto/f1/cotacao?timeoutMs=45000', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answers: {
        name: answerPayloadValue(answers.name),
        mode: answerPayloadValue(answers.mode) || 'real',
        vehicle_brand: answerPayloadValue(answers.vehicle_brand),
        vehicle_brand_text: brandMetadata.brand_text ?? answers.vehicle_brand?.value ?? '',
        vehicle_year: answerPayloadValue(answers.vehicle_year),
        vehicle_model: answerPayloadValue(answers.vehicle_model),
        vehicle_model_text: answers.vehicle_model?.value ?? '',
        vehicle_model_id: modelMetadata.model_id ?? '',
        vehicle_fipe_code: modelMetadata.fipe_code ?? '',
        vehicle_fipe_value: modelMetadata.fipe_value != null ? String(modelMetadata.fipe_value) : '',
        vehicle_fuel_type: modelMetadata.fuel_type ?? '',
        usage: answerPayloadValue(answers.usage),
        renewal_status: answerPayloadValue(answers.renewal_status),
        zip_code: answerPayloadValue(answers.zip_code),
        residence_type: answerPayloadValue(answers.residence_type),
        residence_garage: answerPayloadValue(answers.residence_garage),
        marital_status: answerPayloadValue(answers.marital_status),
        coverage: answerPayloadValue(answers.coverage),
        contact: answerPayloadValue(answers.contact),
        driver_birth_date: answerPayloadValue(answers.driver_birth_date),
        driver_sex: answerPayloadValue(answers.driver_sex),
        document: answerPayloadValue(answers.document),
      },
    }),
  });
  const body = (await response.json()) as AutoF1QuoteResponse | { ok: false; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error('error' in body && body.error ? body.error : 'Não foi possível calcular a cotação.');
  }
  return body;
}

async function postAssistantMessage({
  message,
  stepId,
  answers,
  catalogItems,
  recentMessages,
}: {
  message: string;
  stepId: ActiveFlowStepId;
  answers: Partial<Record<FlowStepId, FlowAnswer>>;
  catalogItems: AssistantCatalogItem[];
  recentMessages: string[];
}): Promise<AssistantMessageResponse> {
  const safeAnswers = Object.fromEntries(
    Object.entries(answers).map(([key, answer]) => [
      key,
      {
        id: answer.id,
        label: answer.label,
        value: answer.value,
        metadata: answer.metadata,
      },
    ]),
  );

  const response = await fetch('/api/assistente/auto/f1/mensagem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      channel: 'webchat' satisfies AssistantChannel,
      snapshot: {
        stepId,
        completed: false,
        answers: safeAnswers,
        recentMessages: recentMessages.slice(-5),
      },
      catalogContext: {
        items: catalogItems.slice(0, 40),
      },
    }),
  });
  const body = (await response.json()) as AssistantMessageResponse | { ok: false; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error('error' in body && body.error ? body.error : 'Não foi possível acionar a IA.');
  }
  return body;
}

async function fetchBrands(): Promise<CatalogBrand[]> {
  const response = await fetch('/test/marcas/carro');
  const body = (await response.json()) as { ok: boolean; status: number; body: CatalogBrand[] };
  if (!body.ok || !Array.isArray(body.body)) {
    throw new Error('Não foi possível carregar a lista de marcas.');
  }
  return body.body;
}

async function fetchModels(brandId: string, modelYear: number): Promise<CatalogModel[]> {
  const response = await fetch(
    `/test/modelos?brand_id=${encodeURIComponent(brandId)}&model_year=${modelYear}&vehicle_type=car`,
  );
  const body = (await response.json()) as {
    ok: boolean;
    status: number;
    body: { models?: CatalogModel[] };
  };
  if (!body.ok || !body.body?.models) {
    throw new Error('Não foi possível carregar os modelos para esta marca/ano.');
  }
  return body.body.models;
}

async function fetchQuoteSummary(guid: string): Promise<QuoteSummary> {
  const response = await fetch(`/api/cotacoes/${encodeURIComponent(guid)}/resumo`);
  const body = (await response.json()) as QuoteSummary | { ok: false; error?: string };
  if (!response.ok || body.ok !== true) {
    throw new Error('Não foi possível carregar o resumo da cotação.');
  }
  return body;
}

function makeMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getStepProgress(
  stepId: FlowStepId,
  completed: boolean,
  visibleSteps: ActiveFlowStepId[],
): number {
  if (completed) return 100;
  if (stepId === 'complete') return 100;
  const index = visibleSteps.indexOf(stepId as ActiveFlowStepId);
  if (index === -1) return 0;
  return Math.round(((index + 1) / visibleSteps.length) * 100);
}

function FlowRail({
  stepId,
  answers,
  completed,
  visibleSteps,
}: {
  stepId: FlowStepId;
  answers: Partial<Record<FlowStepId, FlowAnswer>>;
  completed: boolean;
  visibleSteps: ActiveFlowStepId[];
}): JSX.Element {
  return (
    <ol className="flow-rail" aria-label="Etapas da jornada">
      {visibleSteps.map((id, index) => {
        const step = FLOW_STEPS[id];
        const done = Boolean(answers[id]) || completed;
        const active = stepId === id && !completed;
        return (
          <li key={id} className={`${done ? 'done' : ''}${active ? ' active' : ''}`}>
            <span>{done ? <CheckCircle2 size={15} /> : index + 1}</span>
            <div>
              <strong>{step.title}</strong>
              <small>{answers[id]?.value ?? step.helper}</small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function MessageBubble({ message }: { message: ChatMessage }): JSX.Element {
  return (
    <div className={`chat-message ${message.author}`}>
      <div className="message-avatar" aria-hidden="true">
        {message.author === 'bot' ? <Bot size={17} /> : message.author === 'system' ? <Route size={17} /> : 'V'}
      </div>
      <p>{message.text}</p>
    </div>
  );
}

function AiComposer({
  stepId,
  loading,
  onSubmit,
}: {
  stepId: ActiveFlowStepId;
  loading: boolean;
  onSubmit: (value: string) => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const step = FLOW_STEPS[stepId];

  useEffect(() => {
    setValue('');
  }, [stepId]);

  return (
    <form
      className="ai-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
        if (value.trim()) setValue('');
      }}
    >
      <div className="ai-composer-label">
        <Sparkles size={15} />
        <span>Robocote IA</span>
      </div>
      <input
        value={value}
        placeholder={`Responda livremente: ${step.prompt}`}
        onChange={(event) => setValue(event.target.value)}
        disabled={loading}
      />
      <button type="submit" className="send-button" disabled={loading} aria-label="Enviar para IA">
        {loading ? <RefreshCw size={18} /> : <Send size={18} />}
      </button>
    </form>
  );
}

interface AutocompleteOption {
  id: string;
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

function QuoteReadyAction({ quoteHref }: { quoteHref: string }): JSX.Element {
  return (
    <div className="action-composer">
      <a className="primary-action" href={quoteHref} target="_blank" rel="noreferrer">
        Abrir Quote Room
        <ArrowRight size={16} />
      </a>
    </div>
  );
}

function QuoteMiniPreview({ quote }: { quote: QuoteSummary | null }): JSX.Element {
  const primary = quote?.options.filter((option) => option.category === 'principal').slice(0, 3) ?? [];
  return (
    <section className="journey-card quote-mini-preview">
      <div className="journey-card-title">
        <Car size={18} />
        <span>Cotação conectada</span>
      </div>
      <h3>{quote?.vehicle.label ?? 'Veículo em cotação'}</h3>
      <div className="mini-options">
        {primary.map((option) => (
          <article key={option.id}>
          <strong>{option.productName}</strong>
          <span>{currency.format(option.annualPremium)}</span>
        </article>
      ))}
      {quote === null ? <p>Carregando preview seguro da cotação.</p> : null}
      </div>
    </section>
  );
}

function JourneySummary({
  answers,
  quoteUrl,
  completed,
}: {
  answers: Partial<Record<FlowStepId, FlowAnswer>>;
  quoteUrl: string;
  completed: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const whatsappPreview = buildWhatsappPreview(answers, quoteUrl);

  async function copyMessage(): Promise<void> {
    if (!completed) return;

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(whatsappPreview);
      } else {
        const field = document.createElement('textarea');
        field.value = whatsappPreview;
        field.setAttribute('readonly', 'true');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        document.execCommand('copy');
        field.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="journey-card handoff-card">
      <div className="journey-card-title">
        <MessageCircle size={18} />
        <span>Mensagem WhatsApp</span>
      </div>
      <p>{whatsappPreview}</p>
      <div className="handoff-actions">
        <button type="button" disabled={!completed} onClick={() => void copyMessage()}>
          {copied ? 'Copiado' : 'Copiar mensagem'}
        </button>
        <a href={quoteUrl} target="_blank" rel="noreferrer">
          Abrir link
        </a>
      </div>
    </section>
  );
}

export function DeterministicChat(): JSX.Element {
  const [contract, setContract] = useState<JourneyContract | null>(null);
  const [quote, setQuote] = useState<QuoteSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [stepId, setStepId] = useState<FlowStepId>('name');
  const [answers, setAnswers] = useState<Partial<Record<FlowStepId, FlowAnswer>>>({});
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteRun, setQuoteRun] = useState<QuoteRunState>({ status: 'idle' });
  const [brands, setBrands] = useState<CatalogBrand[]>([]);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [assistantLoading, setAssistantLoading] = useState(false);
  // Buffer das últimas falas do lead que ainda não viraram answer_step.
  // Robocote consulta isso pra lembrar de pistas anteriores (ex: lead disse modelo no step de ano).
  const [recentMessages, setRecentMessages] = useState<string[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchJourneyContract()
      .then((nextContract) => {
        if (cancelled) return;
        setContract(nextContract);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Carrega marcas (NJ) assim que o componente monta — fica disponível pro autocomplete.
  useEffect(() => {
    let cancelled = false;
    fetchBrands()
      .then((list) => {
        if (!cancelled) setBrands(list);
      })
      .catch((e: Error) => {
        if (!cancelled) console.warn('Falha ao carregar marcas:', e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Quando o step ativo for `vehicle_model` e tivermos brand+year preenchidos, busca modelos.
  useEffect(() => {
    if (stepId !== 'vehicle_model') return;
    const brandId = answers.vehicle_brand?.rawValue;
    const yearRaw = answers.vehicle_year?.rawValue ?? answers.vehicle_year?.value;
    const year = Number(yearRaw);
    if (!brandId || !Number.isInteger(year)) {
      setModels([]);
      return;
    }
    let cancelled = false;
    fetchModels(brandId, year)
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setModels([]);
          console.warn('Falha ao carregar modelos:', e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [stepId, answers.vehicle_brand, answers.vehicle_year]);

  const quoteHref = quoteRun.status === 'ready' && quoteRun.guid
    ? `/quote-room/${quoteRun.guid}`
    : contract?.quoteRoomPath ?? '/quote-room';
  const quoteUrl = `${window.location.origin}${quoteHref}`;
  const currentStep = stepId === 'complete' ? null : FLOW_STEPS[stepId];
  const visibleSteps = useMemo(() => getVisibleSteps(answers), [answers]);
  const progress = getStepProgress(stepId, completed, visibleSteps);
  const isCalculating = quoteRun.status === 'running';

  const answerList = useMemo(
    () => visibleSteps.map((id) => answers[id]).filter((answer): answer is FlowAnswer => Boolean(answer)),
    [answers, visibleSteps],
  );

  function normalizeText(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .trim();
  }

  function relevantCatalogItems(items: AutocompleteOption[], message: string): AutocompleteOption[] {
    const normalized = normalizeText(message);
    const terms = normalized.split(/\s+/).filter((term) => term.length >= 3);
    if (!normalized) return items.slice(0, 80);

    const scored = items
      .map((item, index) => {
        const label = normalizeText(item.label);
        const score =
          (label === normalized ? 100 : 0) +
          (label.includes(normalized) ? 50 : 0) +
          (terms.length > 0 && terms.every((term) => label.includes(term)) ? 30 : 0) +
          terms.filter((term) => label.includes(term)).length * 5;
        return { item, index, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.item);

    const selected = scored.length > 0 ? scored : items;
    return selected.slice(0, 120);
  }

  function targetStepFromMessage(message: string): ActiveFlowStepId | null {
    const normalized = normalizeText(message);
    const wantsChange = /(mudar|alterar|corrigir|trocar|voltar|editar)/.test(normalized);
    if (!wantsChange) return null;
    if (/(marca|fabricante)/.test(normalized)) return 'vehicle_brand';
    if (/(ano)/.test(normalized)) return 'vehicle_year';
    if (/(modelo|versao|versao|carro|veiculo)/.test(normalized)) return 'vehicle_model';
    return null;
  }

  function jumpToStep(targetStep: ActiveFlowStepId): void {
    const targetIndex = FLOW_ORDER.indexOf(targetStep);
    if (targetIndex === -1) return;

    const prunedAnswers = Object.fromEntries(
      Object.entries(answers).filter(([key]) => {
        const index = FLOW_ORDER.indexOf(key as ActiveFlowStepId);
        return index !== -1 && index < targetIndex;
      }),
    ) as Partial<Record<FlowStepId, FlowAnswer>>;

    setAnswers(prunedAnswers);
    setStepId(targetStep);
    setCompleted(false);
    setQuoteRun({ status: 'idle' });
    setMessages((prev) => [
      ...prev,
      {
        id: makeMessageId('m-step-change'),
        author: 'bot',
        text: `Claro, vamos corrigir ${FLOW_STEPS[targetStep].title.toLowerCase()}. ${FLOW_STEPS[targetStep].prompt}`,
      },
    ]);
  }

  function resetFlow(): void {
    setMessages(INITIAL_MESSAGES);
    setStepId('name');
    setAnswers({});
    setCompleted(false);
    setQuoteRun({ status: 'idle' });
    setRecentMessages([]);
  }

  function visibleUserText(rawValue: string, answer?: FlowAnswer): string {
    if (answer) return answer.value;
    // Só mascara como CPF se for formato pontuado (intenção clara) ou se passar nos dígitos
    // verificadores. Telefone cru de 11 dígitos não deve virar "<CPF protegido>".
    const masked = rawValue.replace(/\b(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})\b/g, (match, a, b, c, d) => {
      if (/[.\-]/.test(match)) return '<CPF protegido>';
      return isLikelyCpfDigits(`${a}${b}${c}${d}`) ? '<CPF protegido>' : match;
    });
    return masked.replace(/\b\d{5}-?\d{3}\b/g, '<CEP protegido>');
  }

  function isLikelyCpfDigits(digits: string): boolean {
    if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
    const calc = (factor: number) => {
      const total = digits
        .slice(0, factor - 1)
        .split('')
        .reduce((sum, d, i) => sum + Number(d) * (factor - i), 0);
      const mod = (total * 10) % 11;
      return mod === 10 ? 0 : mod;
    };
    return calc(10) === Number(digits[9]) && calc(11) === Number(digits[10]);
  }

  function submitResolvedAnswer({
    step,
    rawValue,
    displayLabel,
    metadata,
    botReply,
  }: {
    step: typeof currentStep;
    rawValue: string;
    displayLabel?: string;
    metadata?: Record<string, unknown>;
    botReply?: string;
  }): void {
    if (!step || completed) return;

    const validation = validateStepValue(step, rawValue);
    if (validation) {
      setMessages((prev) => [
        ...prev,
        {
          id: makeMessageId('m-validation'),
          author: 'system',
          text: validation,
        },
      ]);
      return;
    }

    const answer = buildAnswer(step, rawValue, { displayLabel, metadata });
    const nextAnswers = { ...answers, [step.id]: answer };
    const nextStep = getNextStepId(step.id, nextAnswers);
    setAnswers(nextAnswers);
    setMessages((prev) => [
      ...prev,
      { id: makeMessageId('m-user'), author: 'user', text: visibleUserText(rawValue, answer) },
      ...(botReply ? [{ id: makeMessageId('m-ai-reply'), author: 'bot' as const, text: botReply }] : []),
      ...buildBotFollowUp(nextStep),
    ]);
    setStepId(nextStep);
    if (nextStep === 'complete') setCompleted(true);
  }

  const autocompleteItems: AutocompleteOption[] = useMemo(() => {
    if (stepId === 'vehicle_brand') {
      return brands.map((b) => ({
        id: b.id,
        label: b.text,
        description: b.value !== b.text ? b.value : undefined,
        metadata: { brand_text: b.text, brand_value: b.value },
      }));
    }
    if (stepId === 'vehicle_model') {
      return models.map((m) => ({
        id: m.model_id,
        label: m.value,
        description: `FIPE ${m.data_fipe.fipe_code} · R$ ${m.data_fipe.fipe_value.toLocaleString('pt-BR')} · ${m.fuel_type}`,
        metadata: {
          model_id: m.model_id,
          fipe_code: m.data_fipe.fipe_code,
          fipe_value: m.data_fipe.fipe_value,
          fuel_type: m.fuel_type,
          model_text: m.text,
        },
      }));
    }
    return [];
  }, [stepId, brands, models]);

  async function runQuoteCalculation(startMessages?: ChatMessage[]): Promise<void> {
    if (isCalculating || completed) return;

    setQuoteRun({ status: 'running' });
    setMessages((prev) => [
      ...prev,
      ...(startMessages ?? [
        { id: makeMessageId('m-user'), author: 'user', text: 'Pode calcular a cotação oficial' },
        {
          id: makeMessageId('m-calc-start'),
          author: 'bot',
          text: 'Perfeito. Vou calcular agora e montar sua página de comparação.',
        },
      ]),
    ]);

    try {
      const result = await postAutoF1Quote(answers);
      const quoteLinkAnswer: FlowAnswer = {
        id: 'quote_link',
        label: FLOW_STEPS.quote_link.title,
        value: 'Cotação calculada',
        rawValue: result.guid,
      };
      setQuote(result.quoteSummary);
      setAnswers((prev) => ({ ...prev, quote_link: quoteLinkAnswer }));
      setQuoteRun({
        status: 'ready',
        guid: result.guid,
        callbackId: result.callbackId,
        events: result.events,
        elapsedMs: result.elapsedMs,
      });
      setStepId('complete');
      setCompleted(true);
      setMessages((prev) => [
        ...prev,
        {
          id: makeMessageId('m-calc-ready-1'),
          author: 'bot',
          text: `Cotação concluída: ${result.quoteSummary.metrics.optionCount} opções recebidas e organizadas na Quote Room.`,
        },
        {
          id: makeMessageId('m-calc-ready-2'),
          author: 'bot',
          text: 'Já deixei as opções prontas para comparar preço, cobertura e pontos de atenção.',
        },
      ]);
    } catch (e) {
      const message = (e as Error).message;
      setQuoteRun({ status: 'error', error: message });
      setMessages((prev) => [
        ...prev,
        {
          id: makeMessageId('m-calc-error'),
          author: 'system',
          text: `Não consegui concluir o cálculo agora: ${message}`,
        },
      ]);
    }
  }

  async function submitAssistantMessage(rawMessage: string): Promise<void> {
    if (!currentStep || completed || assistantLoading) return;
    const trimmed = rawMessage.trim();
    if (!trimmed) return;

    const requestedStep = targetStepFromMessage(trimmed);
    if (requestedStep && requestedStep !== currentStep.id) {
      setMessages((prev) => [
        ...prev,
        { id: makeMessageId('m-user'), author: 'user', text: visibleUserText(trimmed) },
      ]);
      jumpToStep(requestedStep);
      return;
    }

    setAssistantLoading(true);
    // Mascara PII (CPF/CEP) antes de mandar pra buffer — evita vazar dado sensível pro prompt.
    const safeForBuffer = visibleUserText(trimmed);
    // SEMPRE acumula a fala atual no buffer: pistas viajam entre steps até virarem irrelevantes
    // (FIFO de 5). Só zera em calculate (cotação) ou resetFlow (reinício).
    setRecentMessages((prev) => [...prev, safeForBuffer].slice(-5));
    try {
      const result = await postAssistantMessage({
        message: trimmed,
        stepId: currentStep.id,
        answers,
        catalogItems: relevantCatalogItems(autocompleteItems, trimmed),
        recentMessages,
      });

      if (result.action === 'calculate') {
        setRecentMessages([]);
        await runQuoteCalculation([
          { id: makeMessageId('m-user'), author: 'user', text: visibleUserText(trimmed) },
          { id: makeMessageId('m-ai-reply'), author: 'bot', text: result.reply },
        ]);
        return;
      }

      if (result.action === 'answer_step' && result.proposedAnswer) {
        submitResolvedAnswer({
          step: currentStep,
          rawValue: result.proposedAnswer.value,
          displayLabel: result.proposedAnswer.displayLabel,
          metadata: result.proposedAnswer.metadata,
          botReply: result.reply,
        });
        return;
      }

      setMessages((prev) => [
        ...prev,
        { id: makeMessageId('m-user'), author: 'user', text: visibleUserText(trimmed) },
        { id: makeMessageId('m-ai-reply'), author: 'bot', text: result.reply },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { id: makeMessageId('m-user'), author: 'user', text: visibleUserText(trimmed) },
        {
          id: makeMessageId('m-ai-error'),
          author: 'system',
          text: `IA indisponível agora: ${(e as Error).message}`,
        },
      ]);
    } finally {
      setAssistantLoading(false);
    }
  }

  return (
    <main className="webchat-shell">
      <section className="webchat-hero">
        <div>
          <span>Robocote IA</span>
          <h1>Webchat F1</h1>
          <p>O Robocote conduz a cotação em conversa natural, valida o roteiro seguro e entrega o link consultivo.</p>
        </div>
        <div className="webchat-status-card">
          <ShieldCheck size={22} />
          <strong>Contrato seguro</strong>
          <small>CPF no fim, dados sensíveis fora da tela e cotação apresentada por link.</small>
        </div>
      </section>

      <div className="webchat-layout">
        <section className="chat-window" aria-label="Webchat com IA Robocote">
          <header className="chat-window-header">
            <img src={robocoteLogo} alt="" />
            <div>
              <strong>Robocote</strong>
              <span>online · conversa por IA</span>
            </div>
            <button type="button" onClick={resetFlow} aria-label="Reiniciar fluxo">
              <RefreshCw size={17} />
            </button>
          </header>

          <div className="chat-progress">
            <span style={{ width: `${progress}%` }} />
          </div>

          <div className="chat-feed" ref={feedRef}>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>

          {currentStep ? (
            <footer className="chat-input-zone">
              <AiComposer
                stepId={currentStep.id}
                loading={assistantLoading}
                onSubmit={(value) => void submitAssistantMessage(value)}
              />
            </footer>
          ) : (
            <footer className="chat-input-zone">
              <QuoteReadyAction quoteHref={quoteHref} />
            </footer>
          )}
        </section>

        <aside className="journey-panel" aria-label="Resumo da jornada">
          <section className="journey-card">
            <div className="journey-card-title">
              <ClipboardCheck size={18} />
              <span>Roteiro seguro</span>
            </div>
            <FlowRail stepId={stepId} answers={answers} completed={completed} visibleSteps={visibleSteps} />
          </section>

          <QuoteMiniPreview quote={quote} />

          {quoteRun.status === 'ready' && quoteRun.events ? (
            <section className="journey-card run-card">
              <div className="journey-card-title">
                <CheckCircle2 size={18} />
                <span>Cálculo oficial</span>
              </div>
              <dl>
                <div>
                  <dt>GUID</dt>
                  <dd>{quoteRun.guid?.slice(0, 8)}...</dd>
                </div>
                <div>
                  <dt>Eventos</dt>
                  <dd>
                    {quoteRun.events.result} resultados · {quoteRun.events.pdf} PDFs
                  </dd>
                </div>
                <div>
                  <dt>Tempo</dt>
                  <dd>{quoteRun.elapsedMs ? `${Math.round(quoteRun.elapsedMs / 1000)}s` : 'concluído'}</dd>
                </div>
              </dl>
            </section>
          ) : null}

          <section className="journey-card answers-card">
            <div className="journey-card-title">
              <Route size={18} />
              <span>Dados coletados</span>
            </div>
            {answerList.length > 0 ? (
              <dl>
                {answerList.map((answer) => (
                  <div key={answer.id}>
                    <dt>{answer.label}</dt>
                    <dd>{answer.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p>Assim que o usuário responder, a jornada aparece aqui.</p>
            )}
            {error ? <p className="journey-error">{error}</p> : null}
          </section>

          <JourneySummary answers={answers} quoteUrl={quoteUrl} completed={completed} />
        </aside>
      </div>
    </main>
  );
}
