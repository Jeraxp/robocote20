import { getResultado, type ResultadoResponse } from '../segfy/resultado.js';
import type { SegfyResponse } from '../segfy/client.js';

type JsonRecord = Record<string, unknown>;

export interface QuoteCoverageSummary {
  coverageType: string;
  fipePercentage: number | null;
  assistance: string;
  glass: string;
  rentalCar: string;
  materialDamage: number | null;
  bodyInjuries: number | null;
  moralDamage: number | null;
  isComprehensive: boolean;
}

export interface QuoteOptionSummary {
  id: string;
  rank: number;
  insurerKey: string;
  insurerName: string;
  productName: string;
  annualPremium: number;
  franchise: number | null;
  category: 'principal' | 'adicional';
  status: string;
  paymentSummary: string;
  coverage: QuoteCoverageSummary;
  badges: string[];
  consultativeNote: string;
  attentionPoints: string[];
  hasPdf: boolean;
  scores: {
    price: number;
    coverage: number;
    balance: number;
  };
}

export interface QuoteRecommendation {
  role: 'cheap' | 'balanced' | 'complete';
  title: string;
  optionId: string;
  reason: string;
}

export type CoveragePreference = 'Economia' | 'Equilíbrio' | 'Proteção' | null;

export interface QuoteCustomerInfo {
  firstName: string | null;
  coveragePreference: CoveragePreference;
}

export interface QuoteSummary {
  ok: true;
  source: 'segfy-show-results';
  guid: string;
  quotationId: string;
  quoteDate: string | null;
  validUntil: string | null;
  customer: QuoteCustomerInfo;
  vehicle: {
    label: string;
    brand: string;
    model: string;
    modelYear: number | null;
    manufactureYear: number | null;
    fipeCode: string;
    fipeValue: number | null;
  };
  metrics: {
    optionCount: number;
    principalCount: number;
    additionalCount: number;
    insurerCount: number;
    minPremium: number | null;
    maxPremium: number | null;
  };
  recommendations: QuoteRecommendation[];
  selectedRecommendation: 'balanced';
  advisor: {
    headline: string;
    summary: string;
    bullets: string[];
  };
  options: QuoteOptionSummary[];
  generatedAt: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/\./g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function getRecord(parent: JsonRecord, key: string): JsonRecord {
  return asRecord(parent[key]);
}

function normalizeText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove códigos numéricos prefixados das descrições da Segfy
 * (ex: "32 - Km Guincho ilimitado" → "Km Guincho ilimitado").
 * O lead brasileiro médio não tem contexto pra entender "32" ou "76".
 */
function humanizeCoverageCode(value: string): string {
  if (!value) return value;
  const cleaned = value.replace(/^\s*\d{1,4}\s*[-–—]\s*/, '');
  return cleaned.trim();
}

/**
 * Traduz jargão de parcelamento da Segfy pra português humano.
 * "Até 10x de R$ 318,80 1ª ADC/Carnê" → "Até 10x de R$ 318,80 (1ª maior)"
 */
function humanizePayment(value: string): string {
  if (!value) return value;
  return value
    .replace(/1[ªa]?\s*ADC\s*\/\s*Carn[êe]/gi, '(1ª maior)')
    .replace(/\bADC\b/g, 'À data do carnê')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Considera assistência/vidros "vazios" quando o texto sinaliza não-contratação.
 * Usado no front pra esconder linhas redundantes.
 */
function isCoverageEmpty(value: string): boolean {
  if (!value) return true;
  const normalized = value.toLowerCase();
  return normalized.includes('não contratad') ||
    normalized.includes('nao contratad') ||
    normalized === 'não informado' ||
    normalized === 'nao informado';
}

function titleCaseCompany(key: string, fallback: string): string {
  const normalized = key.toLowerCase();
  const known: Record<string, string> = {
    azul: 'Azul Seguros',
    itau: 'Itaú Seguros',
    itaú: 'Itaú Seguros',
    porto: 'Porto Seguro',
    mitsui: 'Mitsui Sumitomo',
  };
  return known[normalized] ?? fallback;
}

function productNameFor(companyKey: string, product: string): string {
  if (!product) return titleCaseCompany(companyKey, companyKey);
  if (companyKey === 'porto' && product.toLowerCase() === 'tradicional') {
    return 'Porto Tradicional';
  }
  return product;
}

function coverageScore(coverage: QuoteCoverageSummary, franchise: number | null): number {
  let score = 0;
  if (coverage.isComprehensive) score += 24;
  score += Math.min(24, ((coverage.fipePercentage ?? 0) / 100) * 24);
  score += Math.min(14, ((coverage.materialDamage ?? 0) / 100000) * 7);
  score += Math.min(14, ((coverage.bodyInjuries ?? 0) / 100000) * 7);
  score += Math.min(8, ((coverage.moralDamage ?? 0) / 10000) * 8);

  const assistance = coverage.assistance.toLowerCase();
  if (assistance.includes('ilimitado')) score += 14;
  else if (assistance.includes('500') || assistance.includes('400')) score += 11;
  else if (assistance.includes('300') || assistance.includes('200')) score += 8;
  else if (assistance && !assistance.includes('não contratada')) score += 5;

  const glass = coverage.glass.toLowerCase();
  if (glass && !glass.includes('não contratada')) score += 8;

  if (franchise === 0) score += 2;
  else if (typeof franchise === 'number' && franchise < 12000) score += 8;
  else if (typeof franchise === 'number') score += 5;

  return Math.round(Math.min(score, 100));
}

function buildCoverage(raw: JsonRecord): QuoteCoverageSummary {
  const coverages = getRecord(raw, 'company_coverages');
  const coverageType = stringValue(coverages.coverage_type, 'Não informado');
  const assistance = humanizeCoverageCode(stringValue(coverages.assistence, 'Não informado'));
  const glass = humanizeCoverageCode(stringValue(coverages.glasses, 'Não informado'));
  const rentalCar = humanizeCoverageCode(stringValue(coverages.rental_car, 'Não informado'));
  return {
    coverageType,
    fipePercentage: numberValue(coverages.fipe_percentage),
    assistance,
    glass,
    rentalCar,
    materialDamage: numberValue(coverages.material_damage),
    bodyInjuries: numberValue(coverages.body_injuries),
    moralDamage: numberValue(coverages.moral_damage),
    isComprehensive: coverageType.toLowerCase().includes('compreensiva'),
  };
}

function buildBadges(option: Omit<QuoteOptionSummary, 'rank' | 'badges' | 'consultativeNote' | 'attentionPoints'>): string[] {
  const badges = new Set<string>();
  if (option.category === 'principal') badges.add('Produto principal');
  if (option.coverage.isComprehensive) badges.add('Compreensiva');
  if ((option.coverage.fipePercentage ?? 0) >= 100) badges.add('100% FIPE');
  if (option.franchise === 0) badges.add('Sem franquia informada');
  if (option.coverage.assistance.toLowerCase().includes('ilimitado')) badges.add('Guincho ilimitado');
  return Array.from(badges).slice(0, 4);
}

function buildAttentionPoints(option: Omit<QuoteOptionSummary, 'rank' | 'badges' | 'consultativeNote' | 'attentionPoints'>): string[] {
  const points: string[] = [];
  if (!option.coverage.isComprehensive) {
    points.push('Não é a alternativa mais ampla de cobertura.');
  }
  if ((option.coverage.fipePercentage ?? 0) > 0 && (option.coverage.fipePercentage ?? 0) < 100) {
    points.push(`Indenização em ${option.coverage.fipePercentage}% da FIPE.`);
  }
  if ((option.coverage.materialDamage ?? 0) < 100000) {
    points.push('Danos materiais abaixo do pacote base de referência.');
  }
  if (!option.coverage.assistance || option.coverage.assistance.toLowerCase().includes('não informado')) {
    points.push('Assistência precisa ser conferida antes da proposta.');
  }
  return points.slice(0, 3);
}

function buildNote(
  option: Omit<QuoteOptionSummary, 'rank' | 'badges' | 'consultativeNote' | 'attentionPoints'>,
): string {
  if (!option.coverage.isComprehensive) {
    return 'Boa alternativa econômica, mas deve ser comparada com atenção porque não entrega a cobertura mais ampla.';
  }
  if ((option.coverage.fipePercentage ?? 0) < 100) {
    return 'Menor preço entre as opções principais, com cobertura reduzida em relação às alternativas de 100% FIPE.';
  }
  if (option.coverage.assistance.toLowerCase().includes('ilimitado')) {
    return 'Opção forte para quem valoriza assistência ampla e menor franquia relativa.';
  }
  if (option.annualPremium <= 3100) {
    return 'Combina preço competitivo com pacote compreensivo e 100% FIPE.';
  }
  return 'Cobertura sólida, indicada quando a decisão prioriza proteção e seguradora.';
}

function flattenResults(body: ResultadoResponse): JsonRecord[] {
  return asArray(body.results).flatMap((group) => asArray(asRecord(group).results).map(asRecord));
}

function normalizeOptions(body: ResultadoResponse): QuoteOptionSummary[] {
  const rawOptions = flattenResults(body)
    .filter((raw) => stringValue(raw.status) && numberValue(raw.premium) !== null)
    .filter((raw) => stringValue(raw.status) !== 'error');

  const premiums = rawOptions
    .map((raw) => numberValue(raw.premium))
    .filter((value): value is number => value !== null);
  const minPremium = premiums.length > 0 ? Math.min(...premiums) : 0;
  const maxPremium = premiums.length > 0 ? Math.max(...premiums) : minPremium;
  const spread = Math.max(1, maxPremium - minPremium);

  const baseOptions = rawOptions.map((raw) => {
    const company = getRecord(raw, 'company');
    const companyKey = stringValue(company.name).toLowerCase();
    const fallbackCompanyName = stringValue(company.full_name, companyKey);
    const annualPremium = numberValue(raw.premium) ?? 0;
    const franchise = numberValue(raw.franchise);
    const coverage = buildCoverage(raw);
    const price = Math.round(((maxPremium - annualPremium) / spread) * 100);
    const coveragePoints = coverageScore(coverage, franchise);
    const status = stringValue(raw.status);
    const category: QuoteOptionSummary['category'] = status === 'additional_product' ? 'adicional' : 'principal';
    const option = {
      id: stringValue(raw.result_id, stringValue(raw.id, `${companyKey}-${stringValue(raw.product)}`)),
      rank: 0,
      insurerKey: companyKey,
      insurerName: titleCaseCompany(companyKey, fallbackCompanyName),
      productName: productNameFor(companyKey, stringValue(raw.product)),
      annualPremium,
      franchise,
      category,
      status,
      paymentSummary: humanizePayment(normalizeText(stringValue(raw.best_installment, 'Condição de pagamento em validação'))),
      coverage,
      hasPdf: Boolean(stringValue(getRecord(raw, 'company_data').pdf)),
      scores: {
        price,
        coverage: coveragePoints,
        balance: Math.round(price * 0.55 + coveragePoints * 0.45),
      },
    };

    return {
      ...option,
      badges: buildBadges(option),
      consultativeNote: buildNote(option),
      attentionPoints: buildAttentionPoints(option),
    };
  });

  return baseOptions
    .sort((a, b) => {
      if (a.category !== b.category) return a.category === 'principal' ? -1 : 1;
      return a.annualPremium - b.annualPremium;
    })
    .map((option, index) => ({ ...option, rank: index + 1 }));
}

function pickRecommendations(options: QuoteOptionSummary[]): QuoteRecommendation[] {
  const principal = options.filter((option) => option.category === 'principal');
  const comparable = principal.filter((option) => option.coverage.isComprehensive);
  const pool = comparable.length > 0 ? comparable : principal;
  const cheapest = [...pool].sort((a, b) => a.annualPremium - b.annualPremium)[0] ?? options[0];
  const balancedPool = pool.filter((option) => option.id !== cheapest?.id && (option.coverage.fipePercentage ?? 0) >= 100);
  const balanced = [...(balancedPool.length > 0 ? balancedPool : pool)].sort((a, b) => b.scores.balance - a.scores.balance)[0] ?? cheapest;
  const complete = [...pool].sort((a, b) => {
    if (b.scores.coverage !== a.scores.coverage) return b.scores.coverage - a.scores.coverage;
    return (a.franchise ?? Number.MAX_SAFE_INTEGER) - (b.franchise ?? Number.MAX_SAFE_INTEGER);
  })[0] ?? balanced;

  return [
    {
      role: 'cheap',
      title: 'Menor preço',
      optionId: cheapest.id,
      reason: 'Boa porta de entrada para quem quer reduzir custo mantendo uma opção principal comparável.',
    },
    {
      role: 'balanced',
      title: 'Melhor equilíbrio',
      optionId: balanced.id,
      reason: 'Nossa sugestão inicial: preço competitivo, 100% FIPE e cobertura compreensiva.',
    },
    {
      role: 'complete',
      title: 'Mais completa',
      optionId: complete.id,
      reason: 'Indicada quando assistência, franquia e amplitude da proteção pesam mais que o menor preço.',
    },
  ];
}

function buildAdvisor(
  recommendations: QuoteRecommendation[],
  options: QuoteOptionSummary[],
  customer?: QuoteCustomerInfo,
): QuoteSummary['advisor'] {
  const preference = customer?.coveragePreference ?? null;
  const role = preference === 'Economia'
    ? 'cheap'
    : preference === 'Proteção'
      ? 'complete'
      : 'balanced';
  const target = recommendations.find((item) => item.role === role) ?? recommendations.find((item) => item.role === 'balanced');
  const option = options.find((candidate) => candidate.id === target?.optionId) ?? options[0];
  const firstName = customer?.firstName?.trim();

  const summary = option
    ? (firstName
      ? `${firstName}, ${option.productName} aparece como ${preference ? `melhor opção pra quem priorizou ${preference}` : 'melhor equilíbrio'} pra te recomendar.`
      : `${option.productName} aparece como ${preference ? `melhor opção pra quem priorizou ${preference}` : 'melhor equilíbrio para iniciar a conversa consultiva'}.`)
    : 'Ainda não há opções suficientes para recomendar com segurança.';

  const bullets = preference === 'Economia'
    ? [
        'Opções principais primeiro: menor preço com cobertura compreensiva pesa mais que centavos a menos.',
        'Franquia e percentual FIPE entram na decisão pra evitar surpresa em sinistro.',
        'Alternativas econômicas (Roubo/Incêndio, Assistência) ficam separadas pra comparação justa.',
      ]
    : preference === 'Proteção'
      ? [
          'Score Robocote prioriza assistência ampla, franquia baixa e amplitude de cobertura.',
          'Compreensiva 100% FIPE entrega indenização integral em perda total.',
          'Vale conferir a rede credenciada da seguradora pra ter conforto em sinistro.',
        ]
      : [
          'Compare primeiro as opções principais e deixe produtos adicionais como alternativa de economia.',
          'Preço, franquia e percentual FIPE precisam aparecer juntos para evitar decisão só pelo menor valor.',
          'Posso te explicar qualquer cobertura — é só perguntar antes de decidir.',
        ];

  return {
    headline: 'Recomendação Robocote',
    summary,
    bullets,
  };
}

function buildVehicle(body: ResultadoResponse): QuoteSummary['vehicle'] {
  const payload = getRecord(getRecord(asRecord(body.data), 'data'), 'vehicle');
  const brand = stringValue(payload.brand, 'Veículo');
  const model = stringValue(payload.model, '');
  const modelYear = numberValue(payload.model_year);
  const manufactureYear = numberValue(payload.manufacture_year);
  return {
    label: [brand, modelYear].filter(Boolean).join(' '),
    brand,
    model,
    modelYear,
    manufactureYear,
    fipeCode: stringValue(payload.fipe_code),
    fipeValue: numberValue(payload.fipe_value),
  };
}

function buildCustomer(
  body: ResultadoResponse,
  override?: QuoteCustomerInfo,
): QuoteCustomerInfo {
  // Override (vindo do quote_meta_<guid>.json local) tem prioridade total.
  if (override) return override;
  const payload = getRecord(getRecord(asRecord(body.data), 'data'), 'customer');
  const fullName = stringValue(payload.name);
  const firstName = fullName ? fullName.split(/\s+/)[0] : null;
  return {
    firstName,
    coveragePreference: null,
  };
}

export function normalizeQuoteSummary(
  response: SegfyResponse<ResultadoResponse>,
  customerOverride?: QuoteCustomerInfo,
): QuoteSummary {
  const body = response.body;
  const options = normalizeOptions(body);
  if (options.length === 0) {
    throw new Error('A Segfy não retornou opções calculadas para esta cotação.');
  }

  const recommendations = pickRecommendations(options);
  const premiumValues = options.map((option) => option.annualPremium);
  const insurers = new Set(options.map((option) => option.insurerKey).filter(Boolean));
  const quoteData = getRecord(getRecord(asRecord(body.data), 'data'), 'data');
  const quotePayload = getRecord(asRecord(body.data), 'data');
  const customer = buildCustomer(body, customerOverride);

  return {
    ok: true,
    source: 'segfy-show-results',
    guid: stringValue(body.guid),
    quotationId: stringValue(body.quotation_id, stringValue(body.id)),
    quoteDate: stringValue(quotePayload.quotation_date) || stringValue(quoteData.quotation_date) || null,
    validUntil: stringValue(quotePayload.validity_budget) || stringValue(quoteData.validity_budget) || null,
    customer,
    vehicle: buildVehicle(body),
    metrics: {
      optionCount: options.length,
      principalCount: options.filter((option) => option.category === 'principal').length,
      additionalCount: options.filter((option) => option.category === 'adicional').length,
      insurerCount: insurers.size,
      minPremium: premiumValues.length > 0 ? Math.min(...premiumValues) : null,
      maxPremium: premiumValues.length > 0 ? Math.max(...premiumValues) : null,
    },
    recommendations,
    selectedRecommendation: 'balanced',
    advisor: buildAdvisor(recommendations, options, customer),
    options,
    generatedAt: new Date().toISOString(),
  };
}

export async function getQuoteSummary(
  guid: string,
  customerOverride?: QuoteCustomerInfo,
): Promise<QuoteSummary> {
  return normalizeQuoteSummary(await getResultado({ guid }), customerOverride);
}

export { isCoverageEmpty };
