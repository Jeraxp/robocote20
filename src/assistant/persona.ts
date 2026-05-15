import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const VIVI_PATH = resolve(here, '../../persona/vivi.md');

let cached: string | null = null;
let loadingPromise: Promise<string> | null = null;

async function loadVivi(): Promise<string> {
  const content = await readFile(VIVI_PATH, 'utf8');
  return content.trim();
}

export async function getViviPersona(): Promise<string> {
  if (cached) return cached;
  if (!loadingPromise) {
    loadingPromise = loadVivi().then((content) => {
      cached = content;
      return content;
    });
  }
  return loadingPromise;
}

export function resetViviPersonaCache(): void {
  cached = null;
  loadingPromise = null;
}
