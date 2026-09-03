/**
 * Botões, listas e botão-link no WhatsApp oficial (contrato v3 com o gateway, 03/09/2026).
 *
 * O NÚCLEO NÃO SABE DE BOTÃO — e não deve saber: ele fala texto, igual pro webchat.
 * Este módulo é o adaptador: olha a fala que o motor mandou e decide se ela vira
 * uma mensagem interativa. Três reconhecimentos, todos ancorados em constantes
 * do núcleo (nunca em texto solto):
 *
 *  1. Linhas numeradas "1️⃣ Opção" (triagem e menu de ramos): cada linha vira uma
 *     opção; o corpo é o texto sem as linhas. ≤3 → botões; ≤10 → lista.
 *  2. Perguntas de múltipla escolha do questionário: a fala TERMINA com a pergunta
 *     canônica (STEP_PROMPT[step], com o wording do ramo) → opções da tabela.
 *  3. Resultado da cotação: a linha "Detalhes completos: <url>" vira botão-link.
 *
 * Quem não entra aqui sai como texto. Cada toque no lugar de uma digitação é um
 * degrau a menos pro abandono — mas a versão em texto continua sendo a verdade
 * de referência: é ela que fica na linha do tempo do painel.
 */

import { STEP_PROMPT, applyRamoWording, type StepId } from '../../core/conversation/steps.js';
import type { JourneyRamo } from '../../core/conversation/steps.js';

export interface Opcao {
  id: string;
  titulo: string;
  descricao?: string;
}

export type PlanoInterativo =
  | { tipo: 'botoes'; corpo: string; rodape?: string; botoes: Opcao[] }
  | { tipo: 'lista'; corpo: string; botao: string; secoes: Array<{ titulo: string; itens: Opcao[] }> }
  | { tipo: 'link'; corpo: string; rotulo: string; url: string };

/** Limites da Meta (contrato v3). */
export const LIMITES = {
  botoes: 3,
  tituloBotao: 20,
  itensLista: 10,
  tituloItem: 24,
  descricaoItem: 72,
  corpo: 1024,
  rotuloLink: 20,
} as const;

/**
 * Opções por step. O TÍTULO é o que volta como texto quando o lead toca — então
 * cada título tem que ser algo que o parser do passo entende (os termos das
 * tabelas do assistente). "Pode"/"Não" em vez de "Pode calcular"/"Ainda não":
 * curto, e é o que o motor reconhece como confirmação/negação.
 */
const SIM_NAO: Opcao[] = [
  { id: 'yes', titulo: 'Sim' },
  { id: 'no', titulo: 'Não' },
];

export const OPCOES_POR_STEP: Partial<Record<StepId, Opcao[]>> = {
  usage: [
    { id: 'pessoal', titulo: 'Uso pessoal' },
    { id: 'trabalho', titulo: 'Trabalho/visitas' },
    { id: 'empresa', titulo: 'Empresa/frota' },
  ],
  renewal_status: [
    { id: 'new', titulo: 'Seguro novo' },
    { id: 'renewal', titulo: 'Renovação' },
  ],
  residence_type: [
    { id: 'house', titulo: 'Casa' },
    { id: 'apartment', titulo: 'Apartamento' },
  ],
  residence_garage: [
    { id: 'yes_with_electronic_gate', titulo: 'Portão eletrônico' },
    { id: 'yes_no_electronic_gate', titulo: 'Sem portão' },
    { id: 'no_garage', titulo: 'Não tenho' },
  ],
  marital_status: [
    { id: 'single', titulo: 'Solteiro(a)' },
    { id: 'married', titulo: 'Casado(a)' },
    { id: 'divorced', titulo: 'Divorciado(a)' },
    { id: 'widowed', titulo: 'Viúvo(a)' },
  ],
  coverage: [
    { id: 'economia', titulo: 'Economia' },
    { id: 'equilibrio', titulo: 'Equilíbrio' },
    { id: 'protecao', titulo: 'Proteção' },
  ],
  is_main_driver: [
    { id: 'yes', titulo: 'Sim, sou eu' },
    { id: 'no', titulo: 'Outra pessoa' },
  ],
  young_driver: SIM_NAO,
  studies: SIM_NAO,
  study_garage: SIM_NAO,
  work_commute: SIM_NAO,
  work_garage: SIM_NAO,
  driver_sex: [
    { id: 'male', titulo: 'Masculino' },
    { id: 'female', titulo: 'Feminino' },
  ],
  quote_link: [
    { id: 'calcular', titulo: 'Pode' },
    { id: 'esperar', titulo: 'Não' },
  ],
  res_segment: [
    { id: 'house', titulo: 'Casa' },
    { id: 'apartment', titulo: 'Apartamento' },
  ],
  res_construction: [
    { id: 'masonry', titulo: 'Alvenaria' },
    { id: 'wood', titulo: 'Madeira' },
    { id: 'mixed', titulo: 'Mista' },
  ],
  res_residence_type: [
    { id: 'habitual', titulo: 'Moradia habitual' },
    { id: 'summer_house', titulo: 'Veraneio' },
  ],
  res_condominium: SIM_NAO,
  res_alarm: SIM_NAO,
  res_grills: SIM_NAO,
  res_countryside: SIM_NAO,
  res_owner: SIM_NAO,
  res_new: SIM_NAO,
};

const RAMOS: JourneyRamo[] = ['auto', 'moto', 'caminhao', 'residencial'];
const KEYCAP = /^\s*([1-9]|10)️?⃣\s+(.+?)\s*$/u;

/**
 * Títulos que o núcleo fala por extenso e não cabem num botão (20). O texto do
 * núcleo é caracterização congelada — quem encurta é o adaptador, e o encurtado
 * continua parseável ("atendente" segue lá).
 */
const TITULOS_CURTOS: Record<string, string> = {
  'Falar com um atendente': 'Falar com atendente',
};

/** Encurta um título pro limite sem partir palavra; último recurso, não regra. */
function encurtar(titulo: string, max: number): string {
  const t = TITULOS_CURTOS[titulo.trim()] ?? titulo.trim();
  if (t.length <= max) return t;
  const corte = t.slice(0, max - 1);
  const espaco = corte.lastIndexOf(' ');
  return `${espaco > max / 2 ? corte.slice(0, espaco) : corte}…`;
}

function montarEscolha(corpo: string, opcoes: Opcao[]): PlanoInterativo | null {
  if (!corpo.trim() || corpo.length > LIMITES.corpo || opcoes.length === 0) return null;
  if (opcoes.length <= LIMITES.botoes) {
    return {
      tipo: 'botoes',
      corpo: corpo.trim(),
      botoes: opcoes.map((o) => ({ id: o.id, titulo: encurtar(o.titulo, LIMITES.tituloBotao) })),
    };
  }
  if (opcoes.length <= LIMITES.itensLista) {
    return {
      tipo: 'lista',
      corpo: corpo.trim(),
      botao: 'Escolher',
      secoes: [{
        titulo: 'Opções',
        itens: opcoes.map((o) => ({
          id: o.id,
          titulo: encurtar(o.titulo, LIMITES.tituloItem),
          ...(o.descricao ? { descricao: encurtar(o.descricao, LIMITES.descricaoItem) } : {}),
        })),
      }],
    };
  }
  return null;
}

/** Linhas "1️⃣ Opção" viram opções; o resto é o corpo. */
function planoDeMenuNumerado(text: string): PlanoInterativo | null {
  const linhas = text.split('\n');
  const opcoes: Opcao[] = [];
  const corpoLinhas: string[] = [];
  for (const linha of linhas) {
    const m = linha.match(KEYCAP);
    if (m) opcoes.push({ id: `opt_${m[1]}`, titulo: m[2] });
    else corpoLinhas.push(linha);
  }
  if (opcoes.length < 2) return null;
  const corpo = corpoLinhas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return montarEscolha(corpo, opcoes);
}

/** A fala termina com a pergunta canônica de um step de múltipla escolha? */
function planoDePergunta(text: string): PlanoInterativo | null {
  const fala = text.trimEnd();
  for (const [step, opcoes] of Object.entries(OPCOES_POR_STEP) as Array<[StepId, Opcao[]]>) {
    const base = STEP_PROMPT[step];
    if (!base) continue;
    for (const ramo of RAMOS) {
      const pergunta = applyRamoWording(base, ramo).trimEnd();
      if (fala.endsWith(pergunta)) return montarEscolha(fala, opcoes);
    }
  }
  return null;
}

const LINHA_DETALHES = /^\s*Detalhes completos:\s*(https?:\/\/\S+)\s*$/m;

/** "Cotação pronta … Detalhes completos: <url>" vira corpo + botão-link. */
function planoDeCotacao(text: string): PlanoInterativo | null {
  const m = text.match(LINHA_DETALHES);
  if (!m) return null;
  const url = m[1];
  const corpo = text.replace(LINHA_DETALHES, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!corpo || corpo.length > LIMITES.corpo) return null;
  return { tipo: 'link', corpo, rotulo: 'Ver cotação', url };
}

/**
 * Decide como a fala vai pro WhatsApp. null = texto puro, como sempre foi.
 * Ordem importa: o menu numerado é o mais específico; a cotação vem por último
 * porque o texto dela também termina em disclaimer, não em pergunta.
 */
export function planejarInterativo(text: string): PlanoInterativo | null {
  if (!text || !text.trim()) return null;
  return planoDeMenuNumerado(text) ?? planoDePergunta(text) ?? planoDeCotacao(text);
}
