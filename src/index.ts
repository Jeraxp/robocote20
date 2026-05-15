import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { test } from './routes/test.js';
import { api } from './routes/api.js';
import { whatsapp } from './routes/whatsapp.js';
import { getAssistantModelConfig } from './assistant/autoF1.js';
import { getRagConfig } from './assistant/rag.js';
import { getEvolutionConfig } from './channels/whatsapp/evolution.js';

const app = new Hono();

app.get('/', (c) => c.redirect('/public/index.html'));
app.get('/webchat', (c) => c.redirect('/public/quote-room/index.html?mode=webchat'));
app.get('/quote-room', (c) => c.redirect('/public/quote-room/index.html'));
app.get('/quote-room/:guid', (c) =>
  c.redirect(`/public/quote-room/index.html?guid=${encodeURIComponent(c.req.param('guid'))}`),
);

app.get('/health', (c) => {
  const assistant = getAssistantModelConfig();
  const rag = getRagConfig();
  const evolution = getEvolutionConfig();

  return c.json({
    ok: true,
    service: 'robocote-2.0-spike',
    api: 'segfy-nova-jornada',
    segfy_base_url: process.env.SEGFY_BASE_URL ?? null,
    segfy_socket_url: process.env.SEGFY_SOCKET_URL ?? null,
    client_id_configured: Boolean(process.env.SEGFY_CLIENT_ID),
    client_secret_configured: Boolean(process.env.SEGFY_CLIENT_SECRET),
    corretora_token_configured: Boolean(process.env.RPI_CORRETORA_TOKEN),
    taskdun_ai_configured: assistant.configured,
    taskdun_ai_model: assistant.extractorModel,
    robocote_dialog_model: assistant.dialogModel,
    robocote_complex_dialog_model: assistant.complexDialogModel,
    robocote_extractor_model: assistant.extractorModel,
    robocote_analyst_model: assistant.analystModel,
    robocote_rag_configured: rag.configured,
    robocote_vector_store_configured: rag.vectorStoreConfigured,
    robocote_embedding_model: rag.embeddingModel,
    evolution_configured: evolution.configured,
    evolution_instance: evolution.instance || null,
    evolution_webhook_secret_configured: evolution.webhookSecretConfigured,
    ts: new Date().toISOString(),
  });
});

app.route('/test', test);
app.route('/api', api);
app.route('/webhooks', whatsapp);

app.use('/public/*', serveStatic({ root: './' }));

const port = Number(process.env.PORT ?? 3030);

serve({ fetch: app.fetch, port }, (info) => {
  console.log('');
  console.log('🔥 robocote-2.0-spike — fornalha acesa (Segfy Nova Jornada)');
  console.log(`   http://localhost:${info.port}`);
  console.log(`   http://localhost:${info.port}/health`);
  console.log(`   http://localhost:${info.port}/public/index.html`);
  console.log(`   http://localhost:${info.port}/webchat`);
  console.log(`   http://localhost:${info.port}/quote-room`);
  console.log('');
  console.log('Endpoints de teste:');
  console.log('   GET  /api/jornadas/auto/f1       (contrato determinístico do Webchat F1)');
  console.log('   POST /api/assistente/auto/f1/mensagem (IA Taskdun -> proposta de estado da jornada)');
  console.log('   POST /api/assistente/rag/search   (busca semântica em base RAG, quando configurada)');
  console.log('   POST /api/jornadas/auto/f1/cotacao (Webchat F1 -> socket -> calculate -> Quote Room)');
  console.log('   GET  /api/cotacoes/:guid/resumo  (DTO seguro para Quote Room)');
  console.log('   GET  /test/auth                    (gera Bearer / força refresh com ?refresh=1)');
  console.log('   GET  /test/marcas/:tipo            (carro|moto|caminhao)');
  console.log('   GET  /test/modelos?brand_id&model_year&vehicle_type=car');
  console.log('   GET  /test/profissoes              (profession-list oficial)');
  console.log('   GET  /test/renovacao               (renewal-list oficial)');
  console.log('   GET  /test/placa/:placa            (STUB — indisponível na NJ)');
  console.log('   GET  /test/condutor/:cpf           (STUB — só em Residence)');
  console.log('   POST /test/calcular                (só dispara; sem listener)');
  console.log('   POST /test/cotacao?timeoutMs=30000 (socket.io ANTES do calculate)');
  console.log('   GET  /test/resultado/:guid         (fallback POST show-results)');
  console.log('   GET  /test/listen/:roomId?timeoutMs=15000');
  console.log('   GET  /test/diagnostico/token-transport?run=1');
  console.log('');
});
