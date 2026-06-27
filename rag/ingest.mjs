// rag/ingest.mjs — cria a Vector Store da OpenAI e sobe a base de conhecimento curada.
// Uso (da raiz do projeto robocote-2.0-spike): node rag/ingest.mjs
// Requer TASKDUN_AI_BASE_URL e TASKDUN_AI_API_KEY no .env.
// Ao final, imprime o ROBOCOTE_VECTOR_STORE_ID para você colar no .env (local e na VM).
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.TASKDUN_AI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
const KEY = process.env.TASKDUN_AI_API_KEY?.trim();
const STORE_NAME = process.env.ROBOCOTE_VECTOR_STORE_NAME || 'robocote-knowledge';

if (!KEY) {
  console.error('TASKDUN_AI_API_KEY ausente no .env — abortando.');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const kbDir = join(here, 'knowledge');
const authHeaders = { Authorization: `Bearer ${KEY}`, 'OpenAI-Beta': 'assistants=v2' };

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...authHeaders, ...(init.headers || {}) } });
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} em ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const files = readdirSync(kbDir).filter((f) => /\.(md|txt)$/i.test(f)).sort();
  if (!files.length) {
    console.error(`Nenhum .md/.txt em ${kbDir} — abortando.`);
    process.exit(1);
  }
  console.log(`Base curada: ${files.length} arquivo(s) em ${kbDir}`);

  // 1. Cria a vector store
  const store = await api('/v1/vector_stores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: STORE_NAME }),
  });
  console.log(`Vector store criada: ${store.id}`);

  // 2. Upload de cada arquivo (Files API)
  const fileIds = [];
  for (const name of files) {
    const buf = readFileSync(join(kbDir, name));
    const fd = new FormData();
    fd.append('purpose', 'assistants');
    fd.append('file', new Blob([buf], { type: 'text/markdown' }), name);
    const uploaded = await api('/v1/files', { method: 'POST', body: fd });
    fileIds.push(uploaded.id);
    console.log(`  + ${name} -> ${uploaded.id}`);
  }

  // 3. Anexa em lote à vector store
  await api(`/v1/vector_stores/${store.id}/file_batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_ids: fileIds }),
  });

  // 4. Aguarda a indexação concluir
  for (let i = 0; i < 30; i++) {
    const s = await api(`/v1/vector_stores/${store.id}`);
    const c = s.file_counts || {};
    process.stdout.write(`\r  indexando: completed=${c.completed || 0} in_progress=${c.in_progress || 0} failed=${c.failed || 0}   `);
    if ((c.in_progress || 0) === 0 && (c.total || 0) > 0) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('\n\n==============================================');
  console.log('RAG indexado. Cole no .env (local e na VM):');
  console.log(`ROBOCOTE_VECTOR_STORE_ID=${store.id}`);
  console.log('==============================================');
}

main().catch((e) => {
  console.error('\nFalhou:', e.message);
  process.exit(1);
});
