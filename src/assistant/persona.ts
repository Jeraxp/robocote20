import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const ROBOCOTE_PATH = resolve(here, '../../persona/robocote.md');

let cached: string | null = null;
let loadingPromise: Promise<string> | null = null;

async function loadRobocote(): Promise<string> {
  const content = await readFile(ROBOCOTE_PATH, 'utf8');
  return content.trim();
}

export async function getRobocotePersona(): Promise<string> {
  if (cached) return cached;
  if (!loadingPromise) {
    loadingPromise = loadRobocote().then((content) => {
      cached = content;
      return content;
    });
  }
  return loadingPromise;
}

export function resetRobocotePersonaCache(): void {
  cached = null;
  loadingPromise = null;
}
