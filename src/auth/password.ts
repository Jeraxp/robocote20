import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Hash de senha via scrypt nativo do Node — sem dependência externa.
 *
 * Formato armazenado em users.password_hash:
 *   scrypt$<N>$<salt_hex>$<hash_hex>
 *
 * scrypt é resistente a brute-force por hardware (memory-hard). Parâmetros
 * conservadores (N=16384) dão ~50-100ms por verificação — suficiente pro volume
 * de logins de um painel B2B sem travar UX.
 */

const N = 16384; // cost factor (2^14)
const KEYLEN = 64;
const SALT_BYTES = 16;

/** Wrapper de scrypt que aceita options (maxmem) e retorna Promise<Buffer>. */
function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.length < 6) {
    throw new Error('Senha deve ter ao menos 6 caracteres.');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(plaintext, salt, KEYLEN, { N, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(plaintext: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  if (!Number.isFinite(n) || salt.length === 0 || expected.length === 0) return false;
  try {
    const derived = await scryptAsync(plaintext, salt, expected.length, { N: n, maxmem: 64 * 1024 * 1024 });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Gera senha temporária legível (sem caracteres ambíguos) pro primeiro acesso.
 * Ex: "Rbc-7K9m-4xQ2". Forte o suficiente pra trânsito por email + troca obrigatória.
 */
export function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const pick = (n: number): string => {
    const bytes = randomBytes(n);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  };
  return `Rbc-${pick(4)}-${pick(4)}`;
}
