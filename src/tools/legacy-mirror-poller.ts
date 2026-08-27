/**
 * Observador do legado (Fase 1 da unificação) — espelho de leads por LEITURA PURA.
 *
 * Roda como processo próprio (fora do app web): lê o MySQL compartilhado do legado
 * (SELECTs apenas — nunca escreve lá) e POSTa leads novos/atualizados no receptor
 * /api/ingest/leads do painel novo. Cobre as DUAS gerações (webchat clássica e
 * Typebot/3xxx), porque ambas gravam na mesma tabela `conversas`.
 *
 * Guard-rails (endurecidos pela revisão adversarial):
 *  - zero toque no código/runtime do legado — reversível por natureza (basta parar);
 *  - só espelha corretoras do piloto: LEGACY_MIRROR_TENANT_MAP (cliente_id → tenantId),
 *    validado no boot; conversa de cliente fora do mapa é ignorada e contada;
 *  - marca-d'água persistida em arquivo (caminho resolvido ABSOLUTO e logado no boot);
 *    só avança se o receptor confirmar o lote com ok:true — 503 (falha de persistência
 *    lá) NÃO avança e re-tenta no próximo ciclo;
 *  - janela de SOBREPOSIÇÃO re-varre os últimos ids já vistos: transação MySQL que
 *    commita tarde (id menor que a marca-d'água) não é perdida — o receptor é
 *    idempotente, replay é barato;
 *  - paginação intra-ciclo: backfill/rajada drena página após página sem esperar o
 *    intervalo; sanity-check de relógio no boot (UTC_TIMESTAMP vs relógio local).
 *
 * Env:
 *  LEGACY_MIRROR_DB_HOST / _DB_PORT (3306) / _DB_USER / _DB_PASSWORD / _DB_NAME (robocote)
 *  LEGACY_MIRROR_DB_TZ        default 'Z' (produção confirmada em UTC, 2026-08-27)
 *  LEGACY_MIRROR_INGEST_URL   ex.: https://rcdemo.robocote.com.br/api/ingest/leads
 *  ROBOCOTE_INGEST_SECRET     mesmo secret do receptor
 *  LEGACY_MIRROR_TENANT_MAP   JSON {"<cliente_id>":"<tenantId>", ...} — o piloto
 *  LEGACY_MIRROR_INTERVAL_MS  default 60000
 *  LEGACY_MIRROR_STATE_FILE   default ./legacy-mirror-state.json (resolvido absoluto)
 *  LEGACY_MIRROR_ONESHOT      '1' roda um ciclo (com paginação) e sai; exit 1 se falhar
 *
 * Rodar: npx tsx src/tools/legacy-mirror-poller.ts
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';

const DB_HOST = process.env.LEGACY_MIRROR_DB_HOST?.trim() ?? '';
const DB_PORT = Number(process.env.LEGACY_MIRROR_DB_PORT ?? 3306);
const DB_USER = process.env.LEGACY_MIRROR_DB_USER?.trim() ?? '';
const DB_PASSWORD = process.env.LEGACY_MIRROR_DB_PASSWORD ?? '';
const DB_NAME = process.env.LEGACY_MIRROR_DB_NAME?.trim() || 'robocote';
const DB_TZ = process.env.LEGACY_MIRROR_DB_TZ?.trim() || 'Z';
const INGEST_URL = process.env.LEGACY_MIRROR_INGEST_URL?.trim() ?? '';
const INGEST_SECRET = process.env.ROBOCOTE_INGEST_SECRET?.trim() ?? '';
const INTERVAL_MS = Math.max(15_000, Number(process.env.LEGACY_MIRROR_INTERVAL_MS ?? 60_000));
const STATE_FILE = resolve(process.env.LEGACY_MIRROR_STATE_FILE?.trim() || './legacy-mirror-state.json');
const ONESHOT = process.env.LEGACY_MIRROR_ONESHOT === '1';

const CONVERSAS_PER_PAGE = 200;
const RESPOSTAS_PER_PAGE = 1000;
/** Sobreposição re-varrida a cada ciclo — absorve commits tardios (gaps de auto_increment). */
const CONVERSAS_OVERLAP = 500;
const RESPOSTAS_OVERLAP = 2000;
const MAX_PAGES_PER_CYCLE = 20;
const POST_CHUNK = 50;
const CLOCK_SKEW_WARN_MS = 120_000;

/** cliente_id (legado) → tenantId (painel novo). Só quem está aqui é espelhado. */
function loadTenantMap(): Map<number, string> {
  const raw = process.env.LEGACY_MIRROR_TENANT_MAP?.trim();
  if (!raw) return new Map();
  const parsed = JSON.parse(raw) as Record<string, string>;
  const map = new Map<number, string>();
  for (const [clienteId, tenantId] of Object.entries(parsed)) {
    const id = Number(clienteId);
    const tenant = typeof tenantId === 'string' ? tenantId.trim().toLowerCase() : '';
    if (!Number.isInteger(id) || !/^[a-z0-9_-]+$/.test(tenant)) {
      // Config inválida geraria rejeição permanente lá na frente — aborta AQUI, no boot.
      throw new Error(`LEGACY_MIRROR_TENANT_MAP inválido: "${clienteId}" -> "${tenantId}" (tenant deve casar /^[a-z0-9_-]+$/)`);
    }
    map.set(id, tenant);
  }
  return map;
}

interface MirrorState {
  lastConversaId: number;
  lastRespostaId: number;
}

function loadState(): MirrorState {
  if (!existsSync(STATE_FILE)) {
    console.log(`[espelho] sem marca-d'água anterior (${STATE_FILE}) — começando do zero.`);
    return { lastConversaId: 0, lastRespostaId: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<MirrorState>;
    return {
      lastConversaId: Number.isInteger(parsed.lastConversaId) ? parsed.lastConversaId as number : 0,
      lastRespostaId: Number.isInteger(parsed.lastRespostaId) ? parsed.lastRespostaId as number : 0,
    };
  } catch (e) {
    // Arquivo existe mas está corrompido: replay do zero é seguro (receptor idempotente),
    // mas o operador PRECISA saber — não resetamos em silêncio.
    console.error(`[espelho] ERRO: marca-d'água corrompida em ${STATE_FILE} (${(e as Error).message}) — reiniciando do zero (replay é idempotente).`);
    return { lastConversaId: 0, lastRespostaId: 0 };
  }
}

function saveState(state: MirrorState): void {
  // Escrita atômica: tmp + rename, pra marca-d'água nunca corromper no meio.
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_FILE);
}

interface ConversaRow {
  id: number;
  protocolo: string | null;
  chatbot_id: number;
  cliente_id: number;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface RespostaRow {
  conversa_id: number;
  resposta_name: string | null;
  resposta_value: string | null;
}

function toIso(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Extrai o melhor valor por campo a partir das respostas (a última resposta vence). */
function extractLeadFields(respostas: RespostaRow[]): { nome?: string; email?: string; whatsapp?: string; veiculo?: string } {
  const byName = new Map<string, string>();
  for (const r of respostas) {
    const name = r.resposta_name?.trim().toLowerCase();
    const value = r.resposta_value?.trim();
    if (name && value) byName.set(name, value);
  }
  const marca = byName.get('marca');
  const modelo = byName.get('modelo');
  const veiculo = [marca, modelo].filter(Boolean).join(' ') || byName.get('tipo_seguro');
  return {
    nome: byName.get('nome') ?? byName.get('razao_social'),
    email: byName.get('novo_email') ?? byName.get('email'),
    whatsapp: byName.get('whatsapp') ?? byName.get('telefone') ?? byName.get('celular'),
    veiculo: veiculo || undefined,
  };
}

interface IngestLead {
  protocolo: string;
  tenantId: string;
  nome?: string;
  email?: string;
  whatsapp?: string;
  veiculo?: string;
  origem: string;
  criadoEm?: string;
  atualizadoEm?: string;
}

interface IngestResponse {
  ok?: boolean;
  criados?: number;
  atualizados?: number;
  inalterados?: number;
  rejeitados?: number;
  erros_internos?: number;
  resultados?: Array<{ protocolo?: string; resultado?: string; motivo?: string }>;
}

async function postLeads(leads: IngestLead[]): Promise<void> {
  for (let i = 0; i < leads.length; i += POST_CHUNK) {
    const chunk = leads.slice(i, i + POST_CHUNK);
    const response = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-robocote-ingest-secret': INGEST_SECRET,
      },
      body: JSON.stringify({ leads: chunk }),
    });
    const result = await response.json().catch(() => null) as IngestResponse | null;
    // 503 / ok:false = falha de persistência no receptor → lança e a marca-d'água não avança.
    if (!response.ok || !result || result.ok !== true) {
      const detail = result ? JSON.stringify(result).slice(0, 200) : '';
      throw new Error(`receptor não confirmou o lote (HTTP ${response.status}) ${detail}`);
    }
    // Rejeições de validação são permanentes (re-enviar não muda nada) — mas ficam VISÍVEIS.
    if ((result.rejeitados ?? 0) > 0) {
      const motivos = (result.resultados ?? [])
        .filter((r) => r.resultado === 'rejeitado')
        .map((r) => `${r.protocolo}: ${r.motivo}`)
        .slice(0, 5)
        .join(' | ');
      console.warn(`[espelho] AVISO: ${result.rejeitados} lead(s) rejeitado(s) por validação — ${motivos}`);
    }
    console.log(`[espelho] lote ${chunk.length}: +${result.criados ?? 0} criados, ~${result.atualizados ?? 0} atualizados, =${result.inalterados ?? 0} inalterados, x${result.rejeitados ?? 0} rejeitados`);
  }
}

interface CycleOutcome {
  state: MirrorState;
  /** true = página cheia em alguma consulta — há mais trabalho, repetir sem dormir. */
  more: boolean;
}

async function runCycle(pool: mysql.Pool, tenantMap: Map<number, string>, state: MirrorState): Promise<CycleOutcome> {
  // 1. Conversas NOVAS desde a marca-d'água + janela de SOBREPOSIÇÃO (commits tardios).
  const conversaFloor = Math.max(0, state.lastConversaId - CONVERSAS_OVERLAP);
  const [newConversas] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT c.id, c.protocolo, c.chatbot_id, cb.cliente_id, c.created_at, c.updated_at
     FROM conversas c
     JOIN chatbots cb ON cb.id = c.chatbot_id
     WHERE c.id > ? AND c.deleted_at IS NULL
     ORDER BY c.id ASC
     LIMIT ${CONVERSAS_PER_PAGE}`,
    [state.lastConversaId],
  );
  const [overlapConversas] = state.lastConversaId > 0
    ? await pool.query<mysql.RowDataPacket[]>(
      `SELECT c.id, c.protocolo, c.chatbot_id, cb.cliente_id, c.created_at, c.updated_at
       FROM conversas c
       JOIN chatbots cb ON cb.id = c.chatbot_id
       WHERE c.id > ? AND c.id <= ? AND c.deleted_at IS NULL
       LIMIT ${CONVERSAS_OVERLAP}`,
      [conversaFloor, state.lastConversaId],
    )
    : [[] as mysql.RowDataPacket[]];

  // 2. Respostas novas (+ sobreposição) → conversas que evoluíram depois do primeiro espelho.
  const respostaFloor = Math.max(0, state.lastRespostaId - RESPOSTAS_OVERLAP);
  const [newRespostas] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, conversa_id FROM conversas_respostas
     WHERE id > ?
     ORDER BY id ASC
     LIMIT ${RESPOSTAS_PER_PAGE}`,
    [state.lastRespostaId],
  );
  const [overlapRespostas] = state.lastRespostaId > 0
    ? await pool.query<mysql.RowDataPacket[]>(
      `SELECT id, conversa_id FROM conversas_respostas
       WHERE id > ? AND id <= ?
       LIMIT ${RESPOSTAS_OVERLAP}`,
      [respostaFloor, state.lastRespostaId],
    )
    : [[] as mysql.RowDataPacket[]];

  const touchedIds = new Set<number>();
  for (const c of [...newConversas, ...overlapConversas] as ConversaRow[]) touchedIds.add(c.id);
  for (const r of [...newRespostas, ...overlapRespostas] as Array<{ conversa_id: number }>) touchedIds.add(r.conversa_id);

  const more = newConversas.length === CONVERSAS_PER_PAGE || newRespostas.length === RESPOSTAS_PER_PAGE;

  if (touchedIds.size === 0) {
    return { state, more: false }; // reino quieto — nada a espelhar
  }

  // 3. Carrega as conversas tocadas (novas + sobrepostas + evoluídas) com dono.
  const idList = [...touchedIds];
  const [conversas] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT c.id, c.protocolo, c.chatbot_id, cb.cliente_id, c.created_at, c.updated_at
     FROM conversas c
     JOIN chatbots cb ON cb.id = c.chatbot_id
     WHERE c.id IN (?) AND c.deleted_at IS NULL`,
    [idList],
  );

  // 4. Filtra pelo piloto e monta os leads. (Protocolo nasce junto com a conversa no
  //    legado — IniciarInteracao.php grava na mesma request; NULL aqui é lixo antigo.)
  const mirrored = (conversas as ConversaRow[]).filter((c) => tenantMap.has(c.cliente_id) && c.protocolo);
  const skipped = (conversas as ConversaRow[]).length - mirrored.length;

  let leads: IngestLead[] = [];
  if (mirrored.length > 0) {
    const [respostas] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT conversa_id, resposta_name, resposta_value
       FROM conversas_respostas
       WHERE conversa_id IN (?)
       ORDER BY id ASC`,
      [mirrored.map((c) => c.id)],
    );
    const respostasPorConversa = new Map<number, RespostaRow[]>();
    for (const r of respostas as RespostaRow[]) {
      const list = respostasPorConversa.get(r.conversa_id) ?? [];
      list.push(r);
      respostasPorConversa.set(r.conversa_id, list);
    }

    leads = mirrored.map((c) => {
      const fields = extractLeadFields(respostasPorConversa.get(c.id) ?? []);
      return {
        protocolo: String(c.protocolo),
        tenantId: tenantMap.get(c.cliente_id) as string,
        ...fields,
        origem: 'legado',
        criadoEm: toIso(c.created_at),
        atualizadoEm: toIso(c.updated_at),
      };
    });

    // 5. POST — se falhar (rede OU 503 de persistência), lança e a marca-d'água NÃO avança.
    await postLeads(leads);
  }

  const nextState: MirrorState = {
    lastConversaId: (newConversas as ConversaRow[]).reduce((max, c) => Math.max(max, c.id), state.lastConversaId),
    lastRespostaId: (newRespostas as Array<{ id: number }>).reduce((max, r) => Math.max(max, r.id), state.lastRespostaId),
  };
  saveState(nextState);

  console.log(`[espelho] ciclo ok: ${leads.length} espelhados, ${skipped} fora do piloto | marca-d'água conversa=${nextState.lastConversaId} resposta=${nextState.lastRespostaId}${more ? ' | página cheia, continuando…' : ''}`);
  return { state: nextState, more };
}

async function main(): Promise<void> {
  const missing = [
    !DB_HOST && 'LEGACY_MIRROR_DB_HOST',
    !DB_USER && 'LEGACY_MIRROR_DB_USER',
    !INGEST_URL && 'LEGACY_MIRROR_INGEST_URL',
    !INGEST_SECRET && 'ROBOCOTE_INGEST_SECRET',
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`[espelho] env faltando: ${missing.join(', ')}`);
    process.exit(1);
  }

  const tenantMap = loadTenantMap();
  if (tenantMap.size === 0) {
    console.error('[espelho] LEGACY_MIRROR_TENANT_MAP vazio — nenhum piloto configurado, nada a fazer.');
    process.exit(1);
  }

  const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    connectionLimit: 2,
    timezone: DB_TZ,
  });

  // Sanity-check de relógio: se o MySQL do legado divergir do nosso UTC, timestamps
  // espelhados nasceriam deslocados PARA SEMPRE — melhor gritar no boot.
  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT UTC_TIMESTAMP() AS utc_agora');
    const dbUtcMs = new Date(String(rows[0]?.utc_agora)).getTime();
    const skew = Math.abs(dbUtcMs - Date.now());
    if (Number.isFinite(skew) && skew > CLOCK_SKEW_WARN_MS) {
      console.warn(`[espelho] AVISO: relógio do MySQL diverge ${Math.round(skew / 1000)}s do local — confira LEGACY_MIRROR_DB_TZ (atual '${DB_TZ}').`);
    }
  } catch (e) {
    console.warn(`[espelho] sanity-check de relógio falhou: ${(e as Error).message}`);
  }

  const initialState = loadState();
  console.log(`[espelho] observador no ar — ${tenantMap.size} corretora(s) no piloto, ciclo ${INTERVAL_MS}ms, receptor ${INGEST_URL}`);
  console.log(`[espelho] marca-d'água: ${STATE_FILE} (conversa=${initialState.lastConversaId}, resposta=${initialState.lastRespostaId})`);

  let state = initialState;
  let running = true;
  const stop = () => { running = false; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (running) {
    let cycleFailed = false;
    try {
      // Paginação intra-ciclo: drena backfill/rajada página a página antes de dormir.
      let pages = 0;
      let outcome: CycleOutcome = { state, more: true };
      while (outcome.more && pages < MAX_PAGES_PER_CYCLE && running) {
        outcome = await runCycle(pool, tenantMap, outcome.state);
        pages += 1;
      }
      state = outcome.state;
    } catch (e) {
      cycleFailed = true;
      console.warn(`[espelho] ciclo falhou (re-tento no próximo): ${(e as Error).message}`);
    }
    if (ONESHOT) {
      if (cycleFailed) process.exitCode = 1;
      break;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, INTERVAL_MS));
  }

  await pool.end();
  console.log('[espelho] observador encerrado.');
}

void main();
