/**
 * REGRA DURA da Fase 3, transformada em teste.
 *
 * O núcleo da conversa não pode conhecer canal nenhum. Se um import de
 * `channels/` entrar em `core/`, a extração se desfaz em silêncio e voltamos a
 * ter dois produtos com o mesmo nome — que era exatamente o problema.
 *
 * Este teste é o cadeado. Ele falha ANTES de o estrago virar arquitetura.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const RAIZ = new URL('../../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function arquivosTs(dir: string): Promise<string[]> {
  const entradas = await readdir(dir, { withFileTypes: true });
  const saida: string[] = [];
  for (const e of entradas) {
    const caminho = join(dir, e.name);
    if (e.isDirectory()) saida.push(...(await arquivosTs(caminho)));
    else if (e.name.endsWith('.ts')) saida.push(caminho);
  }
  return saida;
}

test('o núcleo da conversa NÃO importa nada de channels/', async () => {
  const arquivos = await arquivosTs(join(RAIZ, 'core'));
  assert.ok(arquivos.length > 0, 'o núcleo precisa existir');

  const infratores: string[] = [];
  for (const arquivo of arquivos) {
    const conteudo = await readFile(arquivo, 'utf8');
    if (/from\s+['"][^'"]*channels\//.test(conteudo)) infratores.push(arquivo);
  }

  assert.deepEqual(
    infratores,
    [],
    'núcleo importando de channels/ — a extração da Fase 3 foi desfeita',
  );
});

test('o núcleo não fala de WhatsApp no código', async () => {
  const arquivos = await arquivosTs(join(RAIZ, 'core'));
  const infratores: string[] = [];
  for (const arquivo of arquivos) {
    const conteudo = await readFile(arquivo, 'utf8');
    // Comentário pode citar o canal para explicar história; código, não.
    const semComentarios = conteudo
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '');
    if (/sendWhatsappText|EvolutionInbound|CloudApiInbound|whatsappInstance/i.test(semComentarios)) {
      infratores.push(arquivo);
    }
  }
  assert.deepEqual(infratores, [], 'o motor voltou a conhecer o canal');
});
