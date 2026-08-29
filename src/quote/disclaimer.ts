/**
 * Ressalva que acompanha TODA cotação apresentada ao lead.
 *
 * Por quê: o funil é curto de propósito (decisão de produto do Jera, 5 anos de
 * campo — questionário longo derruba conversão, e a cotação é isca; quem fecha é
 * o corretor). O preço mostrado, portanto, parte de premissas que o segurado não
 * confirmou. Dizer isso em voz alta é o que separa ESTIMAR de DECLARAR.
 *
 * Um texto só, usado no Quote Room e no WhatsApp — se a ressalva mudar, muda nos
 * dois ao mesmo tempo. Configurável por ambiente; por corretora, na Fase 6.
 */

export const QUOTE_DISCLAIMER =
  process.env.ROBOCOTE_QUOTE_DISCLAIMER?.trim() ||
  'Simulação sujeita a confirmação: as condições e o valor final podem variar de acordo com fatores não informados aqui.';
