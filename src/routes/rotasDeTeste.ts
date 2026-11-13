import type { MiddlewareHandler } from 'hono';

/**
 * Rotas de teste só existem com `ROBOCOTE_ROTAS_DE_TESTE=1` (desenvolvimento local).
 *
 * Elas não pedem login: o console `/test` consulta pessoa por CPF na Segfy e
 * dispara cotação real com a credencial da corretora, e as rotas avulsas da API
 * gastam cotação e IA sem dono. Sem a variável, respondem como rota inexistente.
 */
export function rotasDeTesteLigadas(): boolean {
  return process.env.ROBOCOTE_ROTAS_DE_TESTE?.trim() === '1';
}

export const exigirRotasDeTeste: MiddlewareHandler = async (c, next) => {
  if (!rotasDeTesteLigadas()) return c.notFound();
  await next();
};
