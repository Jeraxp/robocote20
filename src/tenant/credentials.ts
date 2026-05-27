import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { getPostgresPool, isPostgresConfigured } from '../db/postgres.js';

/**
 * Criptografia de credenciais sensíveis por tenant (Segfy, etc).
 *
 * AES-256-GCM com chave em env `CREDENTIAL_ENCRYPTION_KEY` (32 bytes hex).
 * Cada credencial é armazenada como string "iv_hex:authTag_hex:ciphertext_b64".
 *
 * NUNCA logar valores descriptografados. NUNCA retornar token em response de API.
 * Uso: backend interno → fluxo de cotação Segfy.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // GCM padrão

function getEncryptionKey(): Buffer {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!hex) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY não configurada — credenciais de tenant não podem ser lidas/escritas.');
  }
  if (hex.length !== 64) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY deve ter 64 chars hex (32 bytes). Tamanho atual: ${hex.length}.`);
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('base64')}`;
}

export function decrypt(blob: string): string {
  const parts = blob.split(':');
  if (parts.length !== 3) {
    throw new Error('Formato inválido de credencial encriptada (esperado "iv:authTag:ciphertext").');
  }
  const [ivHex, authTagHex, ciphertextB64] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export interface TenantSegfyCredentials {
  corretoraToken: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Lê credenciais Segfy do tenant. Throw se faltarem ou se DB não estiver configurado.
 * Usado pelo fluxo de cotação pra construir auth Segfy em nome da corretora.
 */
export async function getTenantSegfyCredentials(tenantId: string): Promise<TenantSegfyCredentials> {
  if (!isPostgresConfigured()) {
    throw new Error('Postgres não configurado — credenciais de tenant não disponíveis.');
  }
  const result = await getPostgresPool().query<{
    segfy_corretora_token: string | null;
    segfy_client_id: string | null;
    segfy_client_secret: string | null;
  }>(
    'select segfy_corretora_token, segfy_client_id, segfy_client_secret from tenant_credentials where tenant_id = $1 limit 1',
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Tenant ${tenantId} não tem credenciais Segfy cadastradas.`);
  }
  if (!row.segfy_corretora_token || !row.segfy_client_id || !row.segfy_client_secret) {
    throw new Error(`Tenant ${tenantId} tem credenciais Segfy incompletas.`);
  }
  return {
    corretoraToken: decrypt(row.segfy_corretora_token),
    clientId: decrypt(row.segfy_client_id),
    clientSecret: decrypt(row.segfy_client_secret),
  };
}

export async function setTenantSegfyCredentials(
  tenantId: string,
  creds: TenantSegfyCredentials,
): Promise<void> {
  if (!isPostgresConfigured()) {
    throw new Error('Postgres não configurado — credenciais de tenant não podem ser escritas.');
  }
  await getPostgresPool().query(
    `insert into tenant_credentials (tenant_id, segfy_corretora_token, segfy_client_id, segfy_client_secret, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (tenant_id) do update set
       segfy_corretora_token = excluded.segfy_corretora_token,
       segfy_client_id = excluded.segfy_client_id,
       segfy_client_secret = excluded.segfy_client_secret,
       updated_at = now()`,
    [tenantId, encrypt(creds.corretoraToken), encrypt(creds.clientId), encrypt(creds.clientSecret)],
  );
}
