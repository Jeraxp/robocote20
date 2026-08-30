/**
 * Idempotência de mensagem recebida, por id do canal (wamid no WhatsApp oficial).
 *
 * Por que existe (contrato v2, 30/08/2026): "a Meta re-entrega; o gateway também
 * pode re-despachar. Idempotência por messages[].id do lado do motor."
 *
 * Sem isto, uma re-entrega faz o motor processar a MESMA fala duas vezes: o lead
 * recebe a resposta repetida e — pior — a jornada pode andar dois passos com uma
 * frase só, gravando no lead um dado que ele não deu. É o defeito mais caro que
 * existe no nosso produto, porque não parece defeito: parece o robô sendo burro.
 *
 * LIMITE HONESTO DESTA IMPLEMENTAÇÃO: a memória é do processo. Hoje o serviço roda
 * com 1 réplica, e a Meta re-entrega em minutos — então cobre o caso real. Se um dia
 * escalarmos para N réplicas, ou se o processo reiniciar dentro da janela de retry,
 * uma duplicata passa. O conserto definitivo é uma tabela com unique no id; quando
 * a hora chegar, esta função é o único lugar a mudar.
 */

const TTL_MS = 10 * 60 * 1000; // Meta re-entrega em minutos; 10 min cobre com folga.
const TETO = 5000; // trava de memória: nunca cresce sem fim.

const vistos = new Map<string, number>();

function limpar(agora: number): void {
  for (const [id, quando] of vistos) {
    if (agora - quando > TTL_MS) vistos.delete(id);
  }
  if (vistos.size > TETO) {
    // Map preserva ordem de inserção: descarta os mais antigos.
    const sobrando = vistos.size - TETO;
    let i = 0;
    for (const id of vistos.keys()) {
      if (i++ >= sobrando) break;
      vistos.delete(id);
    }
  }
}

/**
 * Marca a mensagem como processada e diz se ela é REPETIDA.
 * Sem id (canais que não fornecem), devolve false — não dá pra deduplicar o que não tem nome.
 */
export function isMensagemRepetida(messageId: string | undefined | null): boolean {
  const id = messageId?.trim();
  if (!id) return false;
  const agora = Date.now();
  limpar(agora);
  if (vistos.has(id)) return true;
  vistos.set(id, agora);
  return false;
}

/** Só para teste — zera a memória entre cenários. */
export function _limparDedup(): void {
  vistos.clear();
}
