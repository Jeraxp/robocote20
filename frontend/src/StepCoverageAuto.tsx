import type { JSX } from 'react';
import { Car, ShieldCheck, Users } from 'lucide-react';
import type { CoverageAuto } from './types';

/**
 * Step de cobertura Auto — componente PURO e reutilizável.
 *
 * Recebe `value` (CoverageAuto) + `onChange`. Não sabe se está num wizard de
 * onboarding ou na seção Configurações do painel — só renderiza os campos e
 * notifica mudanças. Labels amigáveis mapeiam os enums técnicos da Segfy.
 *
 * Os values são os enums oficiais aceitos pela Segfy NJ (validados no backend
 * contra swagger-public.json). O componente exibe label PT-BR mas grava value técnico.
 */

interface Option {
  value: string;
  label: string;
}

const TIPO_COBERTURA: Option[] = [
  { value: 'comprehensive', label: 'Compreensiva (completa)' },
  { value: 'third_party_only', label: 'RCF — Só terceiros' },
  { value: 'exclusive', label: 'Exclusiva incêndio e roubo' },
];

const FRANQUIA: Option[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'reduced_25', label: 'Reduzida 25%' },
  { value: 'reduced_50', label: 'Reduzida 50%' },
  { value: 'reduced_75', label: 'Reduzida 75%' },
  { value: 'facultativa_50', label: 'Facultativa 50%' },
  { value: 'facultativa_100', label: 'Facultativa 100%' },
];

const VIDROS: Option[] = [
  { value: 'no_glass', label: 'Sem cobertura' },
  { value: 'glass_basic_referenced', label: 'Básico (referenciado)' },
  { value: 'glass_basic_unattached', label: 'Básico (livre escolha)' },
  { value: 'glass_total_referenced', label: 'Completo (referenciado)' },
  { value: 'glass_total_unattached', label: 'Completo (livre escolha)' },
  { value: 'glass_vip_referenced', label: 'VIP (referenciado)' },
  { value: 'glass_vip_unattached', label: 'VIP (livre escolha)' },
];

const ASSISTENCIA: Option[] = [
  { value: 'no_assistance', label: 'Não contratar' },
  { value: 'assistance_200_km_referenced', label: '200km (referenciado)' },
  { value: 'assistance_200_km_unattached', label: '200km (livre escolha)' },
  { value: 'assistance_500_km_referenced', label: '500km (referenciado)' },
  { value: 'assistance_500_km_unattached', label: '500km (livre escolha)' },
  { value: 'assistance_1000_km_referenced', label: '1000km (referenciado)' },
  { value: 'assistance_1000_km_unattached', label: '1000km (livre escolha)' },
  { value: 'assistance_no_limit_referenced', label: 'Sem limite (referenciado)' },
  { value: 'assistance_no_limit_unattached', label: 'Sem limite (livre escolha)' },
];

const CARRO_RESERVA: Option[] = [
  { value: 'no_car', label: 'Não contratar' },
  { value: 'rental_car_07_days_referenced', label: '07 dias (referenciado)' },
  { value: 'rental_car_07_days_unattached', label: '07 dias (livre escolha)' },
  { value: 'rental_car_15_days_referenced', label: '15 dias (referenciado)' },
  { value: 'rental_car_15_days_unattached', label: '15 dias (livre escolha)' },
  { value: 'rental_car_30_days_referenced', label: '30 dias (referenciado)' },
  { value: 'rental_car_30_days_unattached', label: '30 dias (livre escolha)' },
];

const TIPO_CARRO_RESERVA: Option[] = [
  { value: 'no_car', label: 'Sem carro reserva' },
  { value: 'basic', label: 'Básico (1.0 sem ar)' },
  { value: 'essential', label: 'Essencial (1.0 com ar)' },
  { value: 'executive', label: 'Executivo (1.4/1.6 com ar)' },
];

const REPOSICAO_ZERO_KM: Option[] = [
  { value: 'no_replacement', label: 'Não contratar' },
  { value: 'zero_km_06_month', label: '06 meses' },
  { value: 'zero_km_12_month', label: '12 meses' },
];

const FIPE_OPTIONS: Option[] = [
  { value: '100', label: '100%' },
  { value: '110', label: '110%' },
];

/** Default Robocote conservador — usado quando tenant ainda não tem config. */
export const DEFAULT_COVERAGE_AUTO: CoverageAuto = {
  tipo_cobertura: 'comprehensive',
  tabela_fipe: 100,
  franquia: 'normal',
  isencao_franquia: false,
  vidros: 'glass_basic_referenced',
  assistencia_24h: 'assistance_200_km_referenced',
  carro_reserva: 'no_car',
  tipo_carro_reserva: 'no_car',
  reposicao_zero_km: 'no_replacement',
  rcf_dm: 100000,
  rcf_dc: 100000,
  danos_morais: 10000,
  app_morte: 10000,
  desp_extras: 0,
};

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="coverage-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}

function MoneyField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label className="coverage-field">
      <span>{label}</span>
      <div className="coverage-money">
        <span className="coverage-money-prefix">R$</span>
        <input
          type="number"
          min={0}
          step={1000}
          value={value}
          onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0)))}
        />
      </div>
    </label>
  );
}

export function StepCoverageAuto({
  value,
  onChange,
}: {
  value: CoverageAuto;
  onChange: (next: CoverageAuto) => void;
}): JSX.Element {
  const set = <K extends keyof CoverageAuto>(key: K, v: CoverageAuto[K]): void => {
    onChange({ ...value, [key]: v });
  };

  return (
    <div className="coverage-auto-form">
      {/* Seção 1 — Cobertura principal */}
      <section className="coverage-block">
        <header className="coverage-block-header">
          <Car size={18} />
          <div>
            <h3>Cobertura principal</h3>
            <p>O que define o núcleo da apólice de auto.</p>
          </div>
        </header>
        <div className="coverage-grid">
          <SelectField label="Tipo de cobertura" value={value.tipo_cobertura} options={TIPO_COBERTURA} onChange={(v) => set('tipo_cobertura', v)} />
          <SelectField label="Tabela FIPE" value={String(value.tabela_fipe)} options={FIPE_OPTIONS} onChange={(v) => set('tabela_fipe', Number(v))} />
          <SelectField label="Franquia" value={value.franquia} options={FRANQUIA} onChange={(v) => set('franquia', v)} />
          <label className="coverage-field coverage-checkbox">
            <input type="checkbox" checked={value.isencao_franquia} onChange={(e) => set('isencao_franquia', e.target.checked)} />
            <span>Isenção de franquia</span>
          </label>
        </div>
      </section>

      {/* Seção 2 — Coberturas adicionais */}
      <section className="coverage-block">
        <header className="coverage-block-header">
          <ShieldCheck size={18} />
          <div>
            <h3>Coberturas adicionais</h3>
            <p>Assistência, vidros e carro reserva.</p>
          </div>
        </header>
        <div className="coverage-grid">
          <SelectField label="Vidros" value={value.vidros} options={VIDROS} onChange={(v) => set('vidros', v)} />
          <SelectField label="Assistência 24h" value={value.assistencia_24h} options={ASSISTENCIA} onChange={(v) => set('assistencia_24h', v)} />
          <SelectField label="Carro reserva" value={value.carro_reserva} options={CARRO_RESERVA} onChange={(v) => set('carro_reserva', v)} />
          <SelectField label="Tipo carro reserva" value={value.tipo_carro_reserva} options={TIPO_CARRO_RESERVA} onChange={(v) => set('tipo_carro_reserva', v)} />
          <SelectField label="Reposição zero km" value={value.reposicao_zero_km} options={REPOSICAO_ZERO_KM} onChange={(v) => set('reposicao_zero_km', v)} />
        </div>
      </section>

      {/* Seção 3 — Cobertura a terceiros */}
      <section className="coverage-block">
        <header className="coverage-block-header">
          <Users size={18} />
          <div>
            <h3>Cobertura a terceiros</h3>
            <p>Valores de responsabilidade civil e APP.</p>
          </div>
        </header>
        <div className="coverage-grid">
          <MoneyField label="RCF — Danos materiais" value={value.rcf_dm} onChange={(v) => set('rcf_dm', v)} />
          <MoneyField label="RCF — Danos corporais" value={value.rcf_dc} onChange={(v) => set('rcf_dc', v)} />
          <MoneyField label="Danos morais" value={value.danos_morais} onChange={(v) => set('danos_morais', v)} />
          <MoneyField label="APP morte" value={value.app_morte} onChange={(v) => set('app_morte', v)} />
          <MoneyField label="Despesas extraordinárias" value={value.desp_extras} onChange={(v) => set('desp_extras', v)} />
        </div>
      </section>
    </div>
  );
}
