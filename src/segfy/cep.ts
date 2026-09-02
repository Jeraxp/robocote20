import { segfyPOST } from './client.js';
import { segfyRamoPath } from './calcular.js';

/**
 * Endereço a partir do CEP — POST /api/residence/version/1.0/zip-code.
 *
 * O swagger documenta só o request ({ data: { zip_code } }); a RESPOSTA não é
 * documentada. Por isso o parser é tolerante: aceita chaves em português
 * (logradouro/bairro/localidade/uf) e em inglês (street/neighborhood/city/state),
 * envelope { data: {...} } ou objeto plano. O primeiro dump real (logName no
 * client) é o que vai congelar o shape — até lá, nada aqui pode lançar.
 *
 * O calculate residence exige `type_street` no enum em inglês da Segfy e o
 * `street` SEM o tipo ("Rua das Flores" → street + "das Flores"). Como a API
 * devolve o logradouro em português com o tipo colado, a separação é feita aqui.
 */

export interface EnderecoCep {
  street: string;
  neighborhood: string;
  city: string;
  state: string;
  /** Enum `type_street` da Segfy (street, avenue, platter…). Ausente = não deu pra inferir. */
  streetType?: string;
}

/** Enum literal `type_street` do swagger residence — a única lista que o calculate aceita. */
export const SEGFY_STREET_TYPES = new Set([
  'set', 'via', 'area', 'core', 'fair', 'farm', 'hill', 'lake', 'lane', 'nook', 'park', 'path', 'plot',
  'road', 'slum', 'alley', 'block', 'field', 'patch', 'plain', 'slope', 'avenue', 'clover', 'colony',
  'garden', 'grange', 'lagoon', 'others', 'sector', 'square', 'street', 'valley', 'airport', 'catwalk',
  'highway', 'platter', 'station', 'terrace', 'viaduct', 'village', 'district', 'courtyard', 'small_farm',
  'condominium', 'residential',
]);

/** Prefixo do logradouro em português (sem acento, minúsculo) → enum Segfy. */
const STREET_TYPE_BY_PREFIX: Record<string, string> = {
  rua: 'street', r: 'street',
  avenida: 'avenue', av: 'avenue',
  travessa: 'platter', tv: 'platter', trav: 'platter',
  alameda: 'lane', al: 'lane',
  rodovia: 'highway', rod: 'highway',
  estrada: 'road', estr: 'road', est: 'road',
  praca: 'square', pca: 'square', pc: 'square',
  largo: 'plain', lgo: 'plain',
  viela: 'alley',
  vila: 'village',
  condominio: 'condominium', cond: 'condominium',
  parque: 'park', pq: 'park',
  jardim: 'garden', jd: 'garden',
  quadra: 'block', qd: 'block',
  ladeira: 'slope',
  loteamento: 'plot',
  setor: 'sector',
  sitio: 'grange',
  chacara: 'small_farm',
  fazenda: 'farm',
  distrito: 'district',
  residencial: 'residential',
  colonia: 'colony',
  vale: 'valley',
  morro: 'hill',
  lago: 'lake',
  lagoa: 'lagoon',
  campo: 'field',
  area: 'area',
  nucleo: 'core',
  feira: 'fair',
  recanto: 'nook',
  vereda: 'path',
  trecho: 'patch',
  favela: 'slum',
  trevo: 'clover',
  conjunto: 'set', cj: 'set',
  aeroporto: 'airport',
  passarela: 'catwalk',
  estacao: 'station',
  esplanada: 'terrace',
  viaduto: 'viaduct',
  patio: 'courtyard',
  via: 'via',
};

const UF_BY_STATE_NAME: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE',
  'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO', maranhao: 'MA',
  'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA',
  paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
  'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
};

function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * Separa o tipo de logradouro do nome: "Rua das Flores" → { street, "das Flores" }.
 * Prefixo desconhecido → 'others' com o nome inteiro (a Segfy aceita; o corretor confere).
 */
export function splitStreetType(logradouro: string): { streetType: string; street: string } {
  const full = logradouro.trim().replace(/\s+/g, ' ');
  const match = /^([^\s.:]+)\.?:?\s+(.+)$/.exec(full);
  if (match) {
    const mapped = STREET_TYPE_BY_PREFIX[fold(match[1])];
    if (mapped) return { streetType: mapped, street: match[2].trim() };
  }
  return { streetType: 'others', street: full };
}

/** Sigla UF em maiúsculo; nome por extenso vira sigla; qualquer outra coisa fica como veio. */
export function normalizeUf(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return UF_BY_STATE_NAME[fold(trimmed)] ?? trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pick(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Desembrulha { data: {...} } (ou { data: [{...}] }) até chegar no objeto do endereço.
 * Duas camadas cobrem o padrão Segfy ({status, data}) e um eventual proxy ({data:{data}}).
 */
function unwrap(body: unknown): Record<string, unknown> | null {
  let current: unknown = body;
  for (let depth = 0; depth < 3; depth += 1) {
    if (Array.isArray(current)) current = current[0];
    const record = asRecord(current);
    if (!record) return null;
    const hasAddressKey = ['logradouro', 'street', 'bairro', 'neighborhood', 'localidade', 'cidade', 'city', 'uf', 'estado', 'state']
      .some((key) => key in record);
    if (hasAddressKey) return record;
    if (!('data' in record)) return record;
    current = record.data;
  }
  return asRecord(current);
}

/** Parser puro da resposta do zip-code. null = corpo sem endereço reconhecível. */
export function parseCepResponse(body: unknown): EnderecoCep | null {
  const record = unwrap(body);
  if (!record) return null;
  const status = typeof record.status === 'string' ? record.status.toUpperCase() : '';
  if (status && status !== 'OK' && status !== 'SUCCESS') return null;

  const logradouro = pick(record, ['logradouro', 'street', 'endereco', 'address']);
  const neighborhood = pick(record, ['bairro', 'neighborhood', 'district']);
  const city = pick(record, ['localidade', 'cidade', 'city', 'municipio']);
  const state = normalizeUf(pick(record, ['uf', 'estado', 'state']));
  if (!logradouro && !city) return null;

  const explicitType = fold(pick(record, ['type_street', 'street_type', 'tipo_logradouro', 'tipo']));
  const result: EnderecoCep = { street: logradouro, neighborhood, city, state };

  if (explicitType && SEGFY_STREET_TYPES.has(explicitType)) {
    result.streetType = explicitType;
  } else if (explicitType && STREET_TYPE_BY_PREFIX[explicitType]) {
    result.streetType = STREET_TYPE_BY_PREFIX[explicitType];
  } else if (logradouro) {
    const split = splitStreetType(logradouro);
    result.streetType = split.streetType;
    result.street = split.street;
  }
  return result;
}

/**
 * Busca o endereço do CEP. NUNCA lança: CEP inválido, rede, 4xx/5xx ou corpo
 * irreconhecível devolvem null — quem chama pergunta o endereço ao lead.
 */
export async function lookupCep(zip: string): Promise<EnderecoCep | null> {
  const digits = (zip ?? '').replace(/\D/g, '');
  if (digits.length !== 8) return null;
  try {
    const res = await segfyPOST<unknown>(
      segfyRamoPath('residence', 'zip-code'),
      { data: { zip_code: digits } },
      `zip_code_${digits.slice(0, 5)}`,
      'body_config_token',
    );
    if (!res || !res.ok) return null;
    return parseCepResponse(res.body);
  } catch (e) {
    console.warn(`⚠️  lookupCep falhou: ${(e as Error).message}`);
    return null;
  }
}
