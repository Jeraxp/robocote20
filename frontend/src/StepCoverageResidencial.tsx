import type { JSX } from 'react';
import { Home, ShieldCheck, Sparkles } from 'lucide-react';
import type { CoverageResidencial } from './types';

/**
 * Step de cobertura Residencial — componente PURO e reutilizável (mesmo contrato
 * do StepCoverageAuto: recebe `value` + `onChange`).
 *
 * Atende o motor Segfy `residence` (/api/residence/version/1.0/calculate), que tem
 * shape próprio. Os values dos selects (`verba`, `assistencia`) são os enums oficiais
 * Segfy; o componente exibe label PT-BR mas grava o value técnico.
 *
 * Aqui ficam só os DEFAULTS que a corretora controla. O valor do imóvel e do conteúdo
 * (que definem o limite de incêndio) vêm do lead na jornada — não no painel.
 */

interface Option {
  value: string;
  label: string;
}

const VERBA: Option[] = [
  { value: 'building_content', label: 'Imóvel + conteúdo' },
  { value: 'building', label: 'Só o imóvel (edificação)' },
  { value: 'content', label: 'Só o conteúdo' },
];

const ASSISTENCIA: Option[] = [
  { value: 'basic', label: 'Básica' },
  { value: 'intermediary', label: 'Intermediária' },
  { value: 'total', label: 'Completa' },
];

/** Default Robocote conservador — usado quando tenant ainda não tem config residencial. */
export const DEFAULT_COVERAGE_RESIDENCIAL: CoverageResidencial = {
  verba: 'building_content',
  assistencia: 'intermediary',
  danos_eletricos: 5000,
  tubulacoes: 5000,
  pagamento_aluguel: 0,
  quebra_vidros: 2000,
  recomposicao_documentos: 1000,
  rc_familiar: 50000,
  roubo_furto: 20000,
  vendaval: 30000,
  impacto_veiculo: 10000,
  danos_morais: 5000,
  desmoronamento: 0,
  terremoto: 0,
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

export function StepCoverageResidencial({
  value,
  onChange,
}: {
  value: CoverageResidencial;
  onChange: (next: CoverageResidencial) => void;
}): JSX.Element {
  const set = <K extends keyof CoverageResidencial>(key: K, v: CoverageResidencial[K]): void => {
    onChange({ ...value, [key]: v });
  };

  return (
    <div className="coverage-auto-form">
      {/* Seção 1 — Verba e assistência */}
      <section className="coverage-block">
        <header className="coverage-block-header">
          <Home size={18} />
          <div>
            <h3>Verba e assistência</h3>
            <p>O que está segurado e o nível de assistência residencial.</p>
          </div>
        </header>
        <div className="coverage-grid">
          <SelectField label="Verba segurada" value={value.verba} options={VERBA} onChange={(v) => set('verba', v)} />
          <SelectField label="Assistência" value={value.assistencia} options={ASSISTENCIA} onChange={(v) => set('assistencia', v)} />
        </div>
      </section>

      {/* Seção 2 — Coberturas patrimoniais */}
      <section className="coverage-block">
        <header className="coverage-block-header">
          <ShieldCheck size={18} />
          <div>
            <h3>Coberturas patrimoniais</h3>
            <p>Limites padrão das principais coberturas do imóvel.</p>
          </div>
        </header>
        <div className="coverage-grid">
          <MoneyField label="Roubo/Furto" value={value.roubo_furto} onChange={(v) => set('roubo_furto', v)} />
          <MoneyField label="Vendaval/Granizo" value={value.vendaval} onChange={(v) => set('vendaval', v)} />
          <MoneyField label="Danos elétricos" value={value.danos_eletricos} onChange={(v) => set('danos_eletricos', v)} />
          <MoneyField label="Impacto de veículo" value={value.impacto_veiculo} onChange={(v) => set('impacto_veiculo', v)} />
          <MoneyField label="Desmoronamento" value={value.desmoronamento} onChange={(v) => set('desmoronamento', v)} />
          <MoneyField label="Terremoto" value={value.terremoto} onChange={(v) => set('terremoto', v)} />
        </div>
      </section>

      {/* Seção 3 — Coberturas complementares */}
      <section className="coverage-block">
        <header className="coverage-block-header">
          <Sparkles size={18} />
          <div>
            <h3>Coberturas complementares</h3>
            <p>Serviços e responsabilidades adicionais.</p>
          </div>
        </header>
        <div className="coverage-grid">
          <MoneyField label="Ruptura de tubulações" value={value.tubulacoes} onChange={(v) => set('tubulacoes', v)} />
          <MoneyField label="Quebra de vidros" value={value.quebra_vidros} onChange={(v) => set('quebra_vidros', v)} />
          <MoneyField label="Recomposição de documentos" value={value.recomposicao_documentos} onChange={(v) => set('recomposicao_documentos', v)} />
          <MoneyField label="Pagamento de aluguel" value={value.pagamento_aluguel} onChange={(v) => set('pagamento_aluguel', v)} />
          <MoneyField label="RC familiar" value={value.rc_familiar} onChange={(v) => set('rc_familiar', v)} />
          <MoneyField label="Danos morais" value={value.danos_morais} onChange={(v) => set('danos_morais', v)} />
        </div>
      </section>
    </div>
  );
}
