/**
 * Ambiente da rede de testes — PRIMEIRO import de todo arquivo de teste.
 *
 * Motivo: os módulos do Robocote congelam `process.env` em `const` no topo
 * (orchestrator.ts:36-37, transport.ts:41, assistant/autoF1.ts:7-12,
 * segfy/client.ts, store.ts). Mexer em env depois do import é no-op silencioso.
 *
 * Também é cinto de segurança: `DOTENV_CONFIG_PATH` aponta para um arquivo vazio,
 * então mesmo que algum caminho não mockado carregue `dotenv/config`, o .env REAL
 * (que tem chave de IA e credencial Segfy de produção) nunca é lido.
 */

process.env.DOTENV_CONFIG_PATH = new URL('./empty.env', import.meta.url).pathname;

// IA desligada -> assistant/autoF1 cai em localRules(): determinístico e offline.
process.env.TASKDUN_AI_BASE_URL = '';
process.env.TASKDUN_AI_API_KEY = '';

// Sem banco -> sessionStore vira InMemorySessionStore (o real, não um dublê).
process.env.DATABASE_URL = '';

// Credenciais de rede zeradas: se algo escapar do dublê, falha em vez de chamar.
process.env.SEGFY_CLIENT_ID = '';
process.env.SEGFY_CLIENT_SECRET = '';
process.env.RPI_CORRETORA_TOKEN = '';

process.env.WHATSAPP_CHANNEL = 'evolution';
process.env.ROBOCOTE_TENANT_ID = 'test';
process.env.ROBOCOTE_QUOTE_BASE_URL = '';

// Formatação estável (o orquestrador usa toLocaleString('pt-BR')).
process.env.TZ = 'America/Sao_Paulo';
process.env.LANG = 'pt_BR.UTF-8';

export const HARNESS_TENANT = 'test';
