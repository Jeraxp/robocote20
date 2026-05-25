import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const PERSONA_PATH = resolve(here, '../../persona/robocote.md');
const AGENT_NAME_PLACEHOLDER = /\{\{AGENT_NAME\}\}/g;

let cachedTemplate: string | null = null;
let loadingPromise: Promise<string> | null = null;

async function loadTemplate(): Promise<string> {
  const content = await readFile(PERSONA_PATH, 'utf8');
  return content.trim();
}

async function getPersonaTemplate(): Promise<string> {
  if (cachedTemplate) return cachedTemplate;
  if (!loadingPromise) {
    loadingPromise = loadTemplate().then((content) => {
      cachedTemplate = content;
      return content;
    });
  }
  return loadingPromise;
}

/**
 * Persona core do agente conversacional, com nome customizado por tenant.
 * O arquivo `persona/robocote.md` tem placeholders `{{AGENT_NAME}}` que são
 * substituídos em runtime pelo nome da corretora-cliente (Helena, Carlos, etc).
 * Default 'Robocote' quando não passado.
 */
export async function getRobocotePersona(agentName = 'Robocote'): Promise<string> {
  const template = await getPersonaTemplate();
  return template.replace(AGENT_NAME_PLACEHOLDER, agentName);
}

export function resetRobocotePersonaCache(): void {
  cachedTemplate = null;
  loadingPromise = null;
}
