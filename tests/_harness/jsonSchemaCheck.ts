/**
 * Validador mínimo de JSON Schema/OpenAPI, só para testes (sem dependência).
 * Cobre `type`, `properties`, `required`, `enum`, `items` e `nullable`;
 * ignora as palavras-chave que não conhece (format, title, description, ...).
 * Devolve violações como texto com o caminho JSON, ex.:
 *   "$.customer.marital_status: 'widowed' fora do enum".
 */

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
  nullable?: boolean;
};

function tipoDe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function confere(tipo: string, v: unknown): boolean {
  switch (tipo) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    default:
      return true; // tipo desconhecido: ignora
  }
}

function mostra(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : JSON.stringify(v);
}

function visita(value: unknown, schema: Schema, path: string, out: string[]): void {
  if (value === null && schema.nullable) return;

  if (schema.type && !confere(schema.type, value)) {
    out.push(`${path}: esperado ${schema.type}, veio ${tipoDe(value)}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    out.push(`${path}: ${mostra(value)} fora do enum`);
  }

  if (schema.properties || schema.required) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const chave of schema.required ?? []) {
        if (!(chave in obj) || obj[chave] === undefined) out.push(`${path}.${chave}: obrigatório ausente`);
      }
      for (const [chave, sub] of Object.entries(schema.properties ?? {})) {
        if (chave in obj && obj[chave] !== undefined) visita(obj[chave], sub, `${path}.${chave}`, out);
      }
    }
  }

  if (schema.items && Array.isArray(value)) {
    value.forEach((item, i) => visita(item, schema.items as Schema, `${path}[${i}]`, out));
  }
}

export function checkAgainstSchema(value: unknown, schema: object): string[] {
  const out: string[] = [];
  visita(value, schema as Schema, '$', out);
  return out;
}
