/**
 * Dublês da rede de testes.
 *
 * Princípio: mockar a FOLHA de rede (segfy/client), não o meio (segfy/placa).
 * Assim `normalizePlate`, `isValidPlateFormat` e `pickPlateDecodeOutcome` rodam
 * o código de PRODUÇÃO — a rede congela o comportamento real, não uma cópia.
 *
 * Regras que não podem ser quebradas:
 *  1. `installMocks()` no corpo do módulo, antes de qualquer `await import` do alvo.
 *  2. O dublê precisa expor TODO export de valor do módulo — inclusive os que só
 *     importadores transitivos usam (senão o processo morre com SyntaxError).
 *  3. Nada de `import` estático de `src/` num arquivo de teste.
 */

import { mock } from 'node:test';

/** Estado mutável compartilhado: cada teste reprograma antes de chamar o turno. */
export interface Ctrl {
  /** Mensagens que o bot tentou enviar, em ordem. */
  sent: Array<{ to: string; text: string }>;
  /** Chamadas que chegaram na folha de rede da Segfy. */
  segfyCalls: Array<{ path: string; body?: unknown }>;
  /** Resposta que a folha da Segfy devolve (envelope real da API). */
  segfyReply: unknown;
  /** Requests recebidos pela IA — é assim que se prova o que foi enviado a ela. */
  aiCalls: unknown[];
  /** Respostas roteirizadas da IA, consumidas em ordem. */
  aiQueue: unknown[];
  /**
   * Quando true, a IA ACEITA o texto recebido como resposta do passo corrente.
   * Sem estado — imune a corrida entre testes que dividem o mesmo `ctrl`.
   * Prefira isto à fila: a fila só serve para roteiro específico, em arquivo próprio.
   */
  aiAutoAccept: boolean;
  /** Resposta padrão da IA quando a fila esvazia. */
  aiDefault: unknown;
  /** 'ok' | 'fail' | 'pending' — comportamento de runAutoF1Quote. */
  quoteMode: 'ok' | 'fail' | 'pending';
  /** Payload que o orquestrador montou para a cotação (prova das presunções). */
  quotePayload: unknown;
  /** Resultado devolvido pela cotação quando quoteMode='ok'. */
  quoteResult: unknown;
  /** Ramos ativos do tenant. */
  ramos: string[];
  /** true = getTenantActiveRamos lança (simula tenant sem config). */
  ramosThrows: boolean;
  /** Itens devolvidos pelo catálogo. */
  catalog: unknown[];
  /** true = wasMessageSentByBot devolve true (eco do próprio bot). */
  isBotEcho: boolean;
  /** true = envio devolve ok:false (simula falha de entrega). */
  sendFails: boolean;
  /** Contador monotônico para provar ORDEM entre envio e persistência. */
  seq: number;
  /** Trilha de eventos ordenados: 'send' e 'upsert'. */
  trail: string[];
}

export function createCtrl(): Ctrl {
  return {
    sent: [],
    segfyCalls: [],
    segfyReply: { ok: false, status: 0, error: 'mock_nao_programado' },
    aiCalls: [],
    aiQueue: [],
    aiAutoAccept: false,
    aiDefault: { action: 'none', reply: '', source: 'local-rules' },
    quoteMode: 'ok',
    quotePayload: null,
    quoteResult: null,
    ramos: ['auto'],
    ramosThrows: false,
    catalog: [],
    isBotEcho: false,
    sendFails: false,
    seq: 0,
    trail: [],
  };
}

/**
 * `options.exports` é a forma correta no Node 24 (`namedExports` está deprecado),
 * mas o @types/node instalado só tipa a antiga — o cast fica isolado aqui.
 */
function m(spec: string, exports: Record<string, unknown>): void {
  (mock.module as unknown as (s: string, o: { exports: Record<string, unknown> }) => void)(
    spec,
    { exports },
  );
}

export interface InstallOptions {
  /** Não mockar a IA (deixa localRules determinístico rodar de verdade). */
  iaReal?: boolean;
}

export function installMocks(ctrl: Ctrl, opts: InstallOptions = {}): void {
  // D1 — transporte: captura em vez de enviar.
  m('../../src/channels/whatsapp/transport.js', {
    getActiveWhatsappChannel: () => 'evolution',
    sendWhatsappText: async (to: string, text: string) => {
      ctrl.sent.push({ to, text });
      ctrl.trail.push(`send:${ctrl.seq++}`);
      return ctrl.sendFails
        ? { ok: false, status: 500, error: 'mock_send_falhou' }
        : { ok: true, status: 200 };
    },
    wasMessageSentByBot: () => ctrl.isBotEcho,
  });

  // D2 — folha de rede da Segfy. Mata o `dotenv/config` do grafo.
  m('../../src/segfy/client.js', {
    segfyRequest: async (path: string, body?: unknown) => {
      ctrl.segfyCalls.push({ path, body });
      return ctrl.segfyReply;
    },
    segfyGET: async (path: string) => {
      ctrl.segfyCalls.push({ path });
      return ctrl.segfyReply;
    },
    segfyPOST: async (path: string, body?: unknown) => {
      ctrl.segfyCalls.push({ path, body });
      return ctrl.segfyReply;
    },
  });

  // D3 — logger: tira o `await mkdir('logs')` de top-level do grafo.
  m('../../src/utils/logger.js', {
    dumpJSON: async () => 'noop',
  });

  // D5 — jornada de cotação (puxa socket.io real se não for mockada).
  m('../../src/journey/autoF1.js', {
    REAL_MODE: 'real',
    buildAutoF1Payload: () => ({}),
    autoF1QuoteRequestSchema: { parse: (v: unknown) => v },
    runAutoF1Quote: async (payload: unknown) => {
      ctrl.quotePayload = payload;
      if (ctrl.quoteMode === 'fail') throw new Error('mock_cotacao_falhou');
      if (ctrl.quoteMode === 'pending') await new Promise(() => undefined); // nunca resolve
      return ctrl.quoteResult ?? {
        guid: 'GUID-TESTE',
        callbackId: 'CB-TESTE',
        quoteSummary: { options: [] },
        events: [],
        elapsedMs: 10,
      };
    },
  });

  // D6 — ramos do tenant (sem isso o menu multi-ramo é inalcançável).
  m('../../src/tenant/quoteConfig.js', {
    VEHICLE_RAMOS: ['auto', 'moto', 'caminhao'],
    VEHICLE_TYPE_BY_RAMO: { auto: 'car', moto: 'motorcycle', caminhao: 'truck' },
    isVehicleRamo: (v: string) => ['auto', 'moto', 'caminhao'].includes(v),
    getTenantActiveRamos: async () => {
      if (ctrl.ramosThrows) throw new Error('mock_tenant_sem_config');
      return ctrl.ramos;
    },
    getTenantQuoteConfig: async () => {
      if (ctrl.ramosThrows) throw new Error('mock_tenant_sem_config');
      return { ramosAtivos: ctrl.ramos };
    },
    getTenantCoverageForRamo: async () => ({}),
    getTenantCoverageResidencial: async () => ({}),
    getTenantSeguradoras: async () => [],
  });

  // D7 — catálogo. `stepNeedsCatalog` é exigido por assistant/autoF1.ts (transitivo).
  m('../../src/catalog/auto.js', {
    stepNeedsCatalog: () => false,
    loadCatalogForStep: async () => ctrl.catalog,
  });

  // D4 — IA roteirizada (opcional: sem isso, localRules real roda offline).
  if (!opts.iaReal) {
    m('../../src/assistant/autoF1.js', {
      handleAutoF1AssistantMessage: async (request: unknown) => {
        ctrl.aiCalls.push(request);
        if (ctrl.aiQueue.length > 0) return ctrl.aiQueue.shift();
        if (ctrl.aiAutoAccept) {
          const req = request as { message?: string; snapshot?: { stepId?: string } };
          const stepId = req.snapshot?.stepId ?? 'name';
          return {
            ok: true, source: 'local-rules', configured: false, mode: 'capture',
            action: 'answer_step', stepId, channel: 'whatsapp', reply: 'Anotei.',
            proposedAnswer: { stepId, value: req.message ?? '', confidence: 1 },
          };
        }
        return ctrl.aiDefault;
      },
      parseAssistantRequest: (v: unknown) => v,
      getAssistantModelConfig: () => ({ configured: false }),
    });
  }
}
