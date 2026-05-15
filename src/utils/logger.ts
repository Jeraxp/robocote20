import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { redactDeep, safeLogName } from './redact.js';

const LOG_DIR = 'logs';

await mkdir(LOG_DIR, { recursive: true });

export async function dumpJSON(name: string, data: unknown): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = join(LOG_DIR, `${ts}__${safeLogName(name)}.json`);
  await writeFile(filename, JSON.stringify(redactDeep(data), null, 2), 'utf-8');
  console.log(`📝 log → ${filename}`);
  return filename;
}
