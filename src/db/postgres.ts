import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function isPostgresConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getPostgresConfig(): {
  configured: boolean;
  ssl: boolean;
} {
  return {
    configured: isPostgresConfigured(),
    ssl: process.env.DATABASE_SSL === '1',
  };
}

export function getPostgresPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL não configurado.');
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DATABASE_POOL_MAX ?? '10'),
    });
  }

  return pool;
}
