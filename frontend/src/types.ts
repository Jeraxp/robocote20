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

export interface CatalogBrand {
  id: string;
  vehicle_type: string;
  value: string;
  text: string;
}

export interface CatalogModelFipe {
  fipe_url: string;
  fipe_code: string;
  fipe_value: number;
}

export interface CatalogModel {
  model_id: string;
  value: string;
  text: string;
  fuel_type: string;
  data_fipe: CatalogModelFipe;
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
  /** Nome do agente exibido no Quote Room (semi-white-label por tenant). */
  agentName: string;
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

/** Cobertura Auto — espelha CoverageAuto do backend (src/tenant/quoteConfig.ts). */
export interface CoverageAuto {
  tipo_cobertura: string;
  tabela_fipe: number;
  franquia: string;
  isencao_franquia: boolean;
  vidros: string;
  assistencia_24h: string;
  carro_reserva: string;
  tipo_carro_reserva: string;
  reposicao_zero_km: string;
  rcf_dm: number;
  rcf_dc: number;
  danos_morais: number;
  app_morte: number;
  desp_extras: number;
}
