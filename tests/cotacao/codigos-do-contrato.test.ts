/**
 * Códigos fora do contrato da Segfy não podem voltar ao código-fonte:
 * o enum vivo de marital_status tem `widower` e o de residence_garage tem
 * `yes_without_electronic_gate`.
 */

import './../_harness/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function arquivosTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? arquivosTs(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

test('nenhum código fora do contrato no código-fonte', () => {
  const raiz = new URL('../../src', import.meta.url).pathname;
  const proibidos = ["'widowed'", 'yes_no_electronic_gate'];
  const achados: string[] = [];
  for (const arq of arquivosTs(raiz)) {
    readFileSync(arq, 'utf8').split('\n').forEach((linha, i) => {
      for (const p of proibidos) if (linha.includes(p)) achados.push(`${arq.slice(raiz.length + 1)}:${i + 1} ${p}`);
    });
  }
  assert.deepEqual(achados, []);
});
