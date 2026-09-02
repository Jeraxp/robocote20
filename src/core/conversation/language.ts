/**
 * Linguagem da conversa — como o Robocote LÊ o que o lead escreveu.
 *
 * Tudo aqui é puro e não sabe de canal: as mesmas regras valem no WhatsApp, no
 * webchat e em qualquer canal futuro. Extraído do orquestrador na Fase 3 da
 * unificação, sem mudar uma vírgula de comportamento — a rede de testes prova.
 */

import type { SessionState } from '../../session/store.js';
import { RAMO_LABELS, type JourneyRamo } from './steps.js';
import { isValidPlateFormat, normalizePlate } from '../../segfy/placa.js';

export /** Pergunta 1 do intake (Jera 2026-05-31): cotação vs atendimento humano. */
const SERVICE_TYPE_QUESTION = [
  'Como posso te ajudar hoje?',
  '1️⃣ Cotação de seguro',
  '2️⃣ Falar com um atendente',
].join('\n\n');

/**
 * Aviso de IA na primeira fala (doutrina do contrato do canal oficial, 30/08):
 * os grandes players avisam; quem esconde que é robô perde o lead na primeira
 * frase estranha. Sem nome de fornecedor — a inteligência é do sistema.
 */
export const AI_NOTICE =
  process.env.ROBOCOTE_AI_NOTICE?.trim() ||
  'Este atendimento usa inteligência artificial e pode cometer erros. Se algo parecer estranho, me avisa que a gente confere.';

export function buildGreeting(agentName: string): string[] {
  return [
    `Olá! Eu sou o ${agentName}, o seu corretor digital inteligente.\n\n_${AI_NOTICE}_`,
    SERVICE_TYPE_QUESTION,
  ];
}

export /** Classifica a resposta da pergunta 1 do intake. */
function parseServiceType(text: string): 'cotacao' | 'atendimento' | null {
  const m = normalizeMsg(text);
  if (!m) return null;
  // Cotação primeiro (mais comum). "1", "cotar", "orçamento", "preço", "simular", "valor".
  if (/^1\b|\bcota|\borcament|\bsimul|\bpreco\b|\bvalor(es)?\b|\bcontrat/.test(m)) return 'cotacao';
  // Atendimento: "2", "atendente", "falar", "humano", "ajuda", "dúvida", "suporte", "pessoa".
  if (/^2\b|\batend|\bfalar\b|\bhumano|\bduvida|\bajuda\b|\bsuporte|\bpessoa\b|\boperador/.test(m)) return 'atendimento';
  return null;
}

export /** Monta a pergunta 2 do intake com os ramos ativos numerados. */
function buildBranchQuestion(ramos: JourneyRamo[]): string {
  const options = ramos.map((r, i) => `${i + 1}️⃣ ${RAMO_LABELS[r]}`).join('\n\n');
  return `Para qual seguro você quer a cotação?\n\n${options}`;
}

export /** Interpreta a escolha do ramo: por número (posição no menu) ou por palavra-chave. */
function parseBranchChoice(text: string, ramos: JourneyRamo[]): JourneyRamo | null {
  const m = normalizeMsg(text);
  if (!m) return null;
  const numMatch = m.match(/^(\d+)\b/);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    if (idx >= 0 && idx < ramos.length) return ramos[idx];
  }
  const byKeyword: Array<{ ramo: JourneyRamo; re: RegExp }> = [
    { ramo: 'auto', re: /\bcarro|\bauto|\bautomovel|\bveiculo\b/ },
    { ramo: 'moto', re: /\bmoto|\bmotocicleta|\bscooter/ },
    { ramo: 'caminhao', re: /\bcaminh|\btruck|\bcarreta/ },
    // normalizeMsg já tirou acentos: "residência"→"residencia", "imóvel"→"imovel".
    { ramo: 'residencial', re: /\bcasa\b|\bresidenc|\bimovel|\bapartamento|\bapto\b|\blar\b/ },
  ];
  for (const { ramo, re } of byKeyword) {
    if (ramos.includes(ramo) && re.test(m)) return ramo;
  }
  return null;
}

export function isLikelyCpfDigits(digits: string): boolean {
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const calc = (factor: number): number => {
    const total = digits
      .slice(0, factor - 1)
      .split('')
      .reduce((sum, d, i) => sum + Number(d) * (factor - i), 0);
    const mod = (total * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(10) === Number(digits[9]) && calc(11) === Number(digits[10]);
}

export function maskCpfPii(value: string): string {
  return value
    // CNPJ pontuado primeiro (formato único, sem ambiguidade)
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '<CNPJ protegido>')
    // CPF: formato pontuado SEMPRE mascara; cru 11 dígitos só se passar em DV
    // (telefone 48988326647 não passa, então fica intacto pra próxima regra)
    .replace(/\b(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})\b/g, (match, a, b, c, d) => {
      if (/[.\-]/.test(match)) return '<CPF protegido>';
      const digits = `${a}${b}${c}${d}`;
      return isLikelyCpfDigits(digits) ? '<CPF protegido>' : match;
    })
    // Telefone (BR celular) — cobre o caso 11 dígitos crus que NÃO eram CPF
    .replace(/\b(?:\+?55\s*)?\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, '<telefone protegido>')
    // CEP: pontuado ou cru, MAS não mascarar se parecer data de nascimento DDMMAAAA
    .replace(/\b(\d{5})-(\d{3})\b/g, '<CEP protegido>')
    .replace(/\b(\d{2})(\d{2})(\d{4})\b/g, (match, dd, mm, yyyy) => {
      const dDay = Number(dd);
      const mMonth = Number(mm);
      const yYear = Number(yyyy);
      // DDMMAAAA plausível pra data de nascimento → não mascara
      if (dDay >= 1 && dDay <= 31 && mMonth >= 1 && mMonth <= 12 && (yYear >= 1900 && yYear <= 2030)) {
        return match;
      }
      // Caso contrário, 8 dígitos = CEP cru
      return '<CEP protegido>';
    });
}

export function normalizeMsg(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\w\s]/g, ' ')
    .trim();
}

export function isCalcConfirmation(message: string): boolean {
  return /\b(sim|pode|calcula|calcular|manda|bora|gerar|ok|vamos|vai)\b/i.test(message);
}

export /** Lead confirmou uma proposta pendente ("sim", "confere", "isso" etc). */
function looksLikeConfirmation(message: string): boolean {
  const m = normalizeMsg(message);
  if (!m) return false;
  if (/^(sim|s|isso|exato|exatamente|certo|correto|confere|positivo|ok|beleza|certinho|claro|perfeito|esse|esse mesmo|esse mesmo sim|e isso|e isso mesmo|e esse|tudo certo|pode ser|pode|fechou|fechado)$/.test(m)) return true;
  if (/^(é|eh)\s*(isso|esse|sim)?$/.test(m)) return true;
  return false;
}

export /** Lead negou uma proposta pendente. */
function looksLikeDenial(message: string): boolean {
  const m = normalizeMsg(message);
  if (!m) return false;
  if (/^(nao|n|errado|errou|negativo|nem|nada disso|nao e|nao e isso|nao e esse|outro|outra)$/.test(m)) return true;
  return false;
}

export /**
 * Lead enviou nome completo (mínimo nome + sobrenome com 2+ chars cada).
 * Necessário porque seguradoras rejeitam o calculate com "Nome não possui sobrenome"
 * — bug observado 2026-05-19 quando lead digitou só "jeronimo" e o sistema avançou.
 * Aceita acentos, hífens (Maria-José) e apóstrofos (D'Angelo).
 */
function looksLikeFullName(message: string): boolean {
  const cleaned = (message ?? '')
    .trim()
    .replace(/[^A-Za-zÀ-ÿ\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleaned.split(' ').filter((p) => p.length >= 2);
  return parts.length >= 2;
}

export /**
 * Lead quer reiniciar a conversa (palavra-chave em qualquer ponto, ou intenção de
 * nova cotação quando a anterior já fechou). Em sessão `completed`, aceita gatilhos
 * mais frouxos ("outro carro", "outro seguro") porque o lead não tem mais nada
 * pra discutir no estado atual além de cotar de novo.
 */
function isResetIntent(message: string, completed: boolean): boolean {
  const m = normalizeMsg(message);
  if (!m) return false;
  if (/\b(reiniciar|recome[cç]ar|come[cç]ar de novo|come[cç]ar do zero|do zero|do come[cç]o|do inicio|nova cota[cç][aã]o|outra cota[cç][aã]o|cotar de novo|nova cotacao|outra cotacao)\b/.test(m)) return true;
  if (completed && /\b(outro carro|outra moto|outro seguro|outro ve[ií]culo|novo carro|nova cota)\b/.test(m)) return true;
  return false;
}

export /**
 * Monta a frase de recapitulação que o bot manda quando o humanOverride expira
 * (24h sem operador) e a próxima mensagem do lead chega. Identidade silenciosa
 * preservada — não menciona que houve troca de operador.
 */
function buildRecapMessage(
  session: SessionState,
  agentName: string,
  currentPromptForStep: string,
): string {
  const firstName = session.customerFirstName?.split(/\s+/)[0]?.trim();
  const opener = firstName ? `Oi ${firstName}, ${agentName} de volta. ` : `${agentName} de volta. `;
  const recap = firstName ? `Pra recapitular, continuamos sua cotação.\n\n` : 'Pra recapitular, continuamos sua cotação.\n\n';
  return `${opener}${recap}${currentPromptForStep}`;
}

export /** Lead avisa que não tem/quer mandar placa ("sem placa", "não tenho", "pular"). */
function looksLikeNoPlateSkip(message: string): boolean {
  const m = normalizeMsg(message);
  if (!m) return false;
  return /^(sem\s*placa|pular|skip|sem|nao\s*tenho|nao\s*sei|nao\s*lembro|nao\s*sei\s*ainda|nao\s*tenho\s*aqui|nao\s*tenho\s*comigo|nao|n)$/.test(m);
}

export /** Extrai padrão de placa (Mercosul AAA1A23 ou antigo AAA1234) dentro de qualquer texto. */
function extractPlateFromMessage(message: string): string | null {
  const matches = message.match(/[A-Za-z]{3}[\s-]?[0-9][0-9A-Za-z][0-9]{2}/g);
  if (!matches) return null;
  for (const m of matches) {
    if (isValidPlateFormat(m)) return normalizePlate(m);
  }
  return null;
}

export /** Extrai um CEP (8 dígitos, com ou sem hífen) de qualquer mensagem. */
function extractZipFromMessage(text: string): string | null {
  const match = text.match(/\b\d{5}-?\d{3}\b/);
  return match ? match[0].replace(/\D/g, '') : null;
}

export /** Extrai CPF válido (com DV correto) de qualquer mensagem. */
function extractValidCpf(text: string): string | null {
  const match = text.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, '');
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return null;
  const calc = (factor: number): number => {
    const total = digits
      .slice(0, factor - 1)
      .split('')
      .reduce((sum, d, i) => sum + Number(d) * (factor - i), 0);
    const mod = (total * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(10) === Number(digits[9]) && calc(11) === Number(digits[10]) ? digits : null;
}

export function maskCpf(digits: string): string {
  if (digits.length !== 11) return '<CPF protegido>';
  return `${digits.slice(0, 3)}.***.***-${digits.slice(9)}`;
}

export function extractFirstName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}
