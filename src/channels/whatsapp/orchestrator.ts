/**
 * Orquestrador WhatsApp: cola sessão + handler conversacional + envio de resposta.
 *
 * Caminho feliz por turno:
 *   1. Resolve sessão pelo (tenantId, phone) — cria se não existe.
 *   2. Se sessão é nova: envia saudação inicial e fica em step `name`.
 *   3. Senão: monta AssistantRequest do estado atual + mensagem nova,
 *      chama handleAutoF1AssistantMessage, aplica resposta (avança step / mantém),
 *      persiste novo estado, envia reply pelo Evolution.
 *   4. Em action=calculate: dispara runAutoF1Quote, manda link do Quote Room.
 *
 * Caminhos não cobertos nesta rodada (próximos):
 *   - Conversa pós-cotação (lead pergunta sobre opções recebidas).
 *   - Retomada explícita ("oi de novo" depois de dias — hoje a sessão sobrevive 7 dias).
 *   - Reset por palavra-chave (lead digita "reiniciar").
 */

import { handleAutoF1AssistantMessage, type AssistantAction } from '../../assistant/autoF1.js';
import { runAutoF1Quote, type AutoF1QuoteRequest } from '../../journey/autoF1.js';
import { loadCatalogForStep } from '../../catalog/auto.js';
import { decodePlate, pickPlateDecodeOutcome, isValidPlateFormat, normalizePlate } from '../../segfy/placa.js';
import { buscarCondutor } from '../../segfy/condutor.js';
import {
  sessionStore,
  createInitialSessionState,
  appendSessionInteraction,
  type SessionState,
  type SessionKey,
} from '../../session/store.js';
import type { WhatsappInboundMessage } from './transport.js';
import { sendWhatsappText, wasMessageSentByBot } from './transport.js';
import { getAgentName } from '../../tenant/agent.js';
import { cacheQuoteContext } from '../../quote/contextCache.js';
import { getTenantActiveRamos, isVehicleRamo, VEHICLE_RAMOS, type VehicleRamo } from '../../tenant/quoteConfig.js';
import { resolveTenantForWhatsappAccount } from '../../tenant/whatsappAccount.js';
import { runConversationTurn, type TurnResult } from '../../core/conversation/turn.js';
import { isMensagemRepetida } from './dedup.js';


const ROBOCOTE_TENANT_ID = process.env.ROBOCOTE_TENANT_ID?.trim() || 'rpi';





























/**
 * Processa uma mensagem inbound do WhatsApp.
 * Retorna o que foi enviado de volta (pra logging/teste), ou null se ignorou.
 */
/**
 * Descobre a CORRETORA dona da mensagem pela conta em que ela chegou.
 *
 * Regra do IROM: sistema que não sabe de quem é o lead não finge que sabe.
 * Quando a conta não está cadastrada, o lead ainda é atendido (não se derruba
 * conversa em produção por falta de cadastro) — mas a sessão fica MARCADA e o
 * log grita, para o painel mostrar e alguém corrigir o cadastro.
 */
async function resolveTenant(
  inbound: WhatsappInboundMessage,
): Promise<{ tenantId: string; unresolved: boolean }> {
  const accountId = inbound.channelAccountId?.trim();
  if (!accountId) {
    // Origem não propagada (canal legado): comportamento histórico, sem alarme.
    return { tenantId: ROBOCOTE_TENANT_ID, unresolved: false };
  }
  const found = await resolveTenantForWhatsappAccount(accountId);
  if (found) return { tenantId: found, unresolved: false };

  console.warn(
    `[tenant] conta de WhatsApp "${accountId}" nao esta cadastrada em whatsapp_instances — ` +
    `lead atendido no tenant padrao "${ROBOCOTE_TENANT_ID}". Cadastre a instancia para o lead ir pra corretora certa.`,
  );
  return { tenantId: ROBOCOTE_TENANT_ID, unresolved: true };
}

export async function processWhatsappTurn(
  inbound: WhatsappInboundMessage,
  options: { tenantId?: string } = {},
): Promise<{ replySent: string | null; action: AssistantAction | 'greet' | 'calc_failed' | 'reset' | 'human_intervention' | 'human_paused' | 'human_handoff_back' | 'human_handoff_requested' | 'service_type' | 'branch_selected'; sessionAfter: SessionState | null }> {
  // ─── Re-entrega: a Meta reenvia o mesmo wamid; o gateway pode re-despachar ────
  // Processar duas vezes faria o lead ouvir a resposta repetida e a jornada andar
  // dois passos com uma frase só. Contrato v2: idempotência é responsabilidade nossa.
  if (isMensagemRepetida(inbound.messageId)) {
    return { replySent: null, action: 'none', sessionAfter: null };
  }

  // Chamada interna com tenant explícito vence; senão, quem manda é a origem.
  const resolvedTenant = options.tenantId
    ? { tenantId: options.tenantId, unresolved: false }
    : await resolveTenant(inbound);
  const tenantId = resolvedTenant.tenantId;
  const key: SessionKey = { tenantId, channel: 'whatsapp', channelUserId: inbound.fromPhone };

  // ─── fromSelf=true: precisa distinguir o BOT (ignorar) do OPERADOR HUMANO (pausar agente) ──
  // Bot registra cada outbound num cache (5min TTL); se o texto não bate, é operador.
  if (inbound.fromSelf) {
    if (wasMessageSentByBot(inbound.fromPhone, inbound.text)) {
      // Foi o próprio bot — comportamento histórico, ignora.
      return { replySent: null, action: 'none', sessionAfter: null };
    }
    // Operador humano mandou pelo WhatsApp Web/app vinculado ao mesmo número.
    // Marca humanOverride pra agente pausar; só faz sentido se já existe sessão.
    const existing = await sessionStore.get(key);
    if (!existing) {
      return { replySent: null, action: 'none', sessionAfter: null };
    }
    const now = Date.now();
    const overrideUpdated: SessionState = {
      ...existing,
      humanOverride: {
        active: true,
        startedAt: existing.humanOverride?.active ? existing.humanOverride.startedAt : now,
        lastActivityAt: now,
        source: existing.humanOverride?.source ?? 'auto_detected',
        operatorId: existing.humanOverride?.operatorId,
      },
    };
    const withInteraction = appendSessionInteraction(overrideUpdated, {
      direction: 'outbound',
      text: inbound.text,
      action: 'human_intervention',
    });
    const persisted = await sessionStore.upsert(withInteraction);
    return { replySent: null, action: 'human_intervention', sessionAfter: persisted };
  }

  // Daqui pra frente é CONVERSA, não canal — o motor cuida.
  return runConversationTurn(
    {
      tenantId,
      channel: 'whatsapp',
      userId: inbound.fromPhone,
      text: inbound.text,
      timestamp: inbound.timestamp,
      tenantUnresolved: resolvedTenant.unresolved,
    },
    { send: (text: string) => sendWhatsappText(inbound.fromPhone, text) },
  );
}








