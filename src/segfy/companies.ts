import { segfyPOST } from './client.js';

/**
 * Universo de seguradoras por vehicle_type, direto da Segfy (`company-list`).
 *
 * Modelo universal (Jera 2026-06-01): em vez de cada corretora curar uma lista,
 * mandamos TODAS as seguradoras ativas do ramo no `/calculate`. A Segfy filtra
 * naturalmente — quem a corretora não tem credencial simplesmente não cota.
 *
 * A própria company-list já vem com a comissão que a corretora (token atual) tem
 * com cada seguradora, então usamos isso como default por seguradora.
 *
 * Cache em memória por vehicle_type (TTL 1h) — a lista é quase estática e isso
 * evita um POST extra a cada cotação. Usa o mesmo bearer cacheado do auth.
 */

interface CompanyListItem {
  id?: string;
  name?: string;
  commission?: string | number;
  comissao?: string | number;
  nome_abreviado?: string;
  inativo?: boolean;
  instabilidade?: boolean;
}

export interface InsurerOption {
  /** Chave Segfy da seguradora (ex: 'porto', 'mapfre') — vai em insurers[].name. */
  name: string;
  /** Comissão da corretora com esta seguradora, conforme company-list. */
  commission: number;
  displayName?: string;
  unstable?: boolean;
}

interface CacheEntry {
  at: number;
  insurers: InsurerOption[];
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Lista as seguradoras ATIVAS que a corretora pode cotar pro vehicle_type
 * (car | truck | motorcycle). Exclui `inativo`. Cacheado por 1h.
 */
export async function getInsurersForVehicleType(vehicleType: string): Promise<InsurerOption[]> {
  const cached = cache.get(vehicleType);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.insurers;

  const res = await segfyPOST<{ data?: CompanyListItem[] }>(
    '/api/vehicle/version/1.0/company-list',
    { data: { vehicle_type: vehicleType } },
    `company_list_${vehicleType}`,
    'body_config_token',
  );
  const list = Array.isArray(res.body?.data) ? res.body.data : [];
  const insurers: InsurerOption[] = list
    .filter((c): c is CompanyListItem => Boolean(c && typeof c.name === 'string' && c.name.trim() && !c.inativo))
    .map((c) => ({
      name: (c.name as string).trim(),
      commission: Number(c.commission ?? c.comissao ?? 0) || 0,
      displayName: c.nome_abreviado,
      unstable: Boolean(c.instabilidade),
    }));

  if (insurers.length > 0) cache.set(vehicleType, { at: Date.now(), insurers });
  return insurers;
}
