import { Hono } from 'hono';
import { getBearer, clearBearerCache } from '../segfy/auth.js';
import { getMarcas, type TipoVeiculo } from '../segfy/marcas.js';
import { getModelos } from '../segfy/modelos.js';
import { getProfissoes } from '../segfy/profissoes.js';
import { getRenovacao } from '../segfy/renovacao.js';
import { buscarPorPlaca } from '../segfy/placa.js';
import { buscarCondutor } from '../segfy/condutor.js';
import { createCallbackId, postCalcular, type CalcularPayload } from '../segfy/calcular.js';
import { getResultado } from '../segfy/resultado.js';
import { openSocket, closeSocket, listenFor, waitForSocketConnect } from '../segfy/socket.js';
import { runTokenTransportDiagnostic } from '../segfy/diagnostico.js';

export const test = new Hono();

test.get('/auth', async (c) => {
  const refresh = c.req.query('refresh') === '1';
  if (refresh) clearBearerCache();
  try {
    const bearer = await getBearer(refresh);
    return c.json({
      ok: true,
      bearer_length: bearer.length,
      refreshed: refresh,
      token_returned_to_client: false,
    });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

test.get('/marcas/:tipo', async (c) => {
  const tipo = c.req.param('tipo') as TipoVeiculo;
  if (!['carro', 'moto', 'caminhao'].includes(tipo)) {
    return c.json({ error: 'tipo deve ser carro, moto ou caminhao' }, 400);
  }
  const r = await getMarcas(tipo);
  return c.json(r);
});

test.get('/modelos', async (c) => {
  const brand_id = c.req.query('brand_id') ?? c.req.query('marca_id');
  const model_year = Number(c.req.query('model_year') ?? c.req.query('ano_modelo'));
  const vehicle_type = (c.req.query('vehicle_type') ?? 'car') as 'car' | 'motorcycle' | 'truck';
  if (!brand_id || !model_year) {
    return c.json({ error: 'brand_id (UUID da NJ) e model_year são obrigatórios' }, 400);
  }
  if (!['car', 'motorcycle', 'truck'].includes(vehicle_type)) {
    return c.json({ error: 'vehicle_type deve ser car, motorcycle ou truck' }, 400);
  }
  const r = await getModelos(brand_id, model_year, vehicle_type);
  return c.json(r);
});

test.get('/profissoes', async (c) => {
  const r = await getProfissoes();
  return c.json(r);
});

test.get('/renovacao', async (c) => {
  const r = await getRenovacao();
  return c.json(r);
});

test.get('/placa/:placa', async (c) => {
  const r = await buscarPorPlaca(c.req.param('placa'));
  return c.json(r);
});

test.get('/condutor/:cpf', async (c) => {
  const r = await buscarCondutor(c.req.param('cpf'));
  return c.json(r);
});

/**
 * Fluxo completo de cotação (Nova Jornada):
 * 1. Abre socket.io com roomId gerado
 * 2. POST /calculate com config.callback = roomId
 * 3. Escuta `timeoutMs` (default 30s)
 * 4. Fecha socket e retorna eventos coletados + resposta do calculate
 */
test.post('/cotacao', async (c) => {
  const payload = (await c.req.json()) as CalcularPayload;
  const timeoutMs = Number(c.req.query('timeoutMs') ?? '30000');
  const connectTimeoutMs = Number(c.req.query('connectTimeoutMs') ?? '5000');
  const callbackId = createCallbackId();
  const session = openSocket(callbackId);

  try {
    await waitForSocketConnect(session, connectTimeoutMs);
    const calcResult = await postCalcular(payload, callbackId);

    await new Promise((res) => setTimeout(res, timeoutMs));
    const events = await closeSocket(session, `cotacao_${callbackId.slice(0, 8)}`);

    return c.json({
      callbackId,
      socket_connected_before_calculate: true,
      calculate_response: calcResult.response,
      socket_events: events,
      event_count: events.length,
    });
  } catch (e) {
    const events = await closeSocket(session, `cotacao_${callbackId.slice(0, 8)}_aborted`);
    return c.json(
      {
        ok: false,
        callbackId,
        socket_connected_before_calculate: false,
        error: (e as Error).message,
        socket_events: events,
        event_count: events.length,
      },
      502,
    );
  }
});

test.post('/calcular', async (c) => {
  const payload = (await c.req.json()) as CalcularPayload;
  const r = await postCalcular(payload);
  return c.json(r);
});

test.get('/resultado/:id', async (c) => {
  const r = await getResultado({
    guid: c.req.param('id'),
    id: c.req.query('id'),
    multicalculo_id: c.req.query('multicalculo_id'),
  });
  return c.json(r);
});

test.get('/listen/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const timeoutMs = Number(c.req.query('timeoutMs') ?? '15000');
  const events = await listenFor(roomId, timeoutMs, `listen_${roomId.slice(0, 8)}`);
  return c.json({ roomId, eventCount: events.length, events });
});

test.get('/diagnostico/token-transport', async (c) => {
  if (c.req.query('run') !== '1') {
    return c.json({
      ok: true,
      dry_run: true,
      message: 'Adicione ?run=1 para testar formatos de token sem disparar cotacao real.',
      requires: {
        bearer_credentials: Boolean(process.env.SEGFY_CLIENT_ID && process.env.SEGFY_CLIENT_SECRET),
        corretora_token: Boolean(process.env.RPI_CORRETORA_TOKEN),
      },
      probes: [
        'POST brand-list via config.token + data',
        'POST model-list via config.token + data',
        'POST profession-list via config.token + data',
        'POST renewal-list via config.token + data',
        'controle negativo: GET brand-list via query corretora_token',
      ],
    });
  }

  if (!process.env.RPI_CORRETORA_TOKEN) {
    return c.json(
      {
        ok: false,
        error: 'RPI_CORRETORA_TOKEN não configurado. Aguarde a Segfy provisionar as credenciais da Nova Jornada.',
      },
      428,
    );
  }

  const results = await runTokenTransportDiagnostic();
  return c.json({ ok: true, results });
});
