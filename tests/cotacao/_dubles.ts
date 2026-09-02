/**
 * Dublês da camada de cotação (segfy + runner residencial).
 *
 * Mesma receita do tests/_harness/mocks.ts — mocka a FOLHA de rede e deixa o
 * código de produção rodar — mas SEM o dublê de journey/autoF1.js: aqui o runner
 * é o alvo, então autoF1.ts e residencialF1.ts rodam de verdade. O que se cala é
 * client (HTTP), socket, logger e a config do tenant (Postgres).
 *
 * Regras herdadas: `installDubles()` antes de qualquer `await import` do alvo;
 * cada dublê expõe TODO export de valor do módulo; nada de import estático de src/.
 */

import { mock } from 'node:test';

export interface Dubles {
  /** Chamadas que chegaram na folha de rede, em ordem. */
  calls: Array<{ path: string; body?: unknown }>;
  /** Resposta da folha por path — cada teste programa a sua. */
  reply: (path: string, body?: unknown) => unknown;
  /** Config do tenant devolvida por getTenantQuoteConfig. */
  config: unknown;
  /** Eventos que o socket "recebeu" (já presentes ao abrir — sem esperar). */
  socketEvents: unknown[];
  /** true = handshake do socket falha. */
  socketConnectFails: boolean;
  /** logNames dos sockets fechados — prova o caminho normal vs abortado. */
  closedSockets: string[];
}

export function createDubles(): Dubles {
  return {
    calls: [],
    reply: () => ({ ok: false, status: 0, body: { status: 'mock_nao_programado' } }),
    config: {},
    socketEvents: [],
    socketConnectFails: false,
    closedSockets: [],
  };
}

function m(spec: string, exports: Record<string, unknown>): void {
  (mock.module as unknown as (s: string, o: { exports: Record<string, unknown> }) => void)(
    spec,
    { exports },
  );
}

export function installDubles(d: Dubles): void {
  m('../../src/segfy/client.js', {
    segfyRequest: async ({ path, body }: { path: string; body?: unknown }) => {
      d.calls.push({ path, body });
      return d.reply(path, body);
    },
    segfyGET: async (path: string) => {
      d.calls.push({ path });
      return d.reply(path);
    },
    segfyPOST: async (path: string, body?: unknown) => {
      d.calls.push({ path, body });
      return d.reply(path, body);
    },
  });

  m('../../src/utils/logger.js', {
    dumpJSON: async () => 'noop',
  });

  m('../../src/segfy/socket.js', {
    openSocket: (roomId: string) => ({ roomId, socket: {}, events: [...d.socketEvents], closedAt: null }),
    waitForSocketConnect: async () => {
      if (d.socketConnectFails) throw new Error('mock_socket_nao_conectou');
    },
    closeSocket: async (session: { events: unknown[] }, logName?: string) => {
      d.closedSockets.push(logName ?? '');
      return session.events;
    },
    listenFor: async () => [],
  });

  m('../../src/tenant/quoteConfig.js', {
    VEHICLE_RAMOS: ['auto', 'moto', 'caminhao'],
    VEHICLE_TYPE_BY_RAMO: { auto: 'car', moto: 'motorcycle', caminhao: 'truck' },
    isVehicleRamo: (v: string) => ['auto', 'moto', 'caminhao'].includes(v),
    getTenantActiveRamos: async () => [],
    getTenantQuoteConfig: async () => d.config,
    getTenantCoverageForRamo: async () => ({}),
    getTenantCoverageResidencial: async () =>
      (d.config as { coberturas?: { residencial?: unknown } })?.coberturas?.residencial,
    getTenantSeguradoras: async () => [],
    getTenantComissao: async () => 0,
    saveTenantQuoteConfig: async () => ({ configId: 0, configHash: '', skipped: true }),
  });
}

/** Padrões de cobertura residencial como o painel grava (CoverageResidencial). */
export const COBERTURA_RESIDENCIAL = {
  verba: 'building_content',
  assistencia: 'basic',
  danos_eletricos: 5000,
  tubulacoes: 3000,
  pagamento_aluguel: 3000,
  quebra_vidros: 2000,
  recomposicao_documentos: 1000,
  rc_familiar: 30000,
  roubo_furto: 10000,
  vendaval: 20000,
  impacto_veiculo: 10000,
  danos_morais: 5000,
  desmoronamento: 0,
  terremoto: 0,
};

/** Jornada residencial completa (modo validação), rawValue por stepId. */
export function respostasResidencial(over: Record<string, string> = {}): Record<string, string> {
  return {
    name: 'Ana Ribeiro',
    document: '123.456.789-09',
    contact: '(48) 99999-1234',
    driver_sex: 'female',
    driver_birth_date: '10/05/1985',
    renewal_status: 'new',
    res_zip: '88010-400',
    res_street: 'Rua Felipe Schmidt',
    res_number: '100',
    res_complement: 'ap 302',
    res_neighborhood: 'Centro',
    res_city: 'Florianópolis',
    res_state: 'sc',
    res_segment: 'apartment',
    res_construction: 'masonry',
    res_residence_type: 'habitual',
    res_building_value: '300000',
    res_content_value: '50000',
    res_condominium: 'yes',
    res_alarm: 'no',
    res_grills: 'no',
    res_countryside: 'no',
    res_owner: 'yes',
    res_new: 'yes',
    ...over,
  };
}

/** Envelope mínimo de show-results que o normalizador aceita (1 opção válida). */
export function showResultsMinimo(guid: string): unknown {
  return {
    ok: true,
    status: 200,
    body: {
      status: 'OK',
      guid,
      results: [
        {
          results: [
            {
              status: 'success',
              premium: 1250.5,
              product: 'Residencial Essencial',
              best_installment: 'Até 10x de R$ 125,05',
              result_id: 'r1',
              company: { name: 'porto', full_name: 'Porto Seguro' },
              company_coverages: {},
              company_data: {},
            },
          ],
        },
      ],
      data: { data: { customer: { name: 'Ana Ribeiro' }, residence: { zip_code: '88010400', city: 'Florianópolis', state: 'SC' } } },
    },
  };
}
