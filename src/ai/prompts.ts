import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BookForgeError } from '../domain/errors.js';

/**
 * prompts/README.md: prompts are versioned independently from application code.
 * Each file starts with a `---` block carrying at least `version:`.
 */
export interface LoadedPrompt {
  id: string;
  version: string;
  body: string;
}

const cache = new Map<string, LoadedPrompt>();

function promptDir(): string {
  return resolve(process.cwd(), 'prompts');
}

export function loadPrompt(id: string): LoadedPrompt {
  const cached = cache.get(id);
  if (cached) return cached;

  const file = resolve(promptDir(), `${id}.md`);
  if (!existsSync(file)) {
    throw new BookForgeError('PROMPT_MISSING', `Prompt "${id}" not found at prompts/${id}.md`, 500);
  }

  const raw = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);

  let version = '0';
  let body = raw;
  if (match) {
    const frontmatter = match[1] ?? '';
    version = /^version:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? '0';
    body = raw.slice(match[0].length);
  }

  const prompt: LoadedPrompt = { id, version, body: body.trim() };
  cache.set(id, prompt);
  return prompt;
}

/** Prompts are read from disk once; call this after editing them in dev. */
export function clearPromptCache(): void {
  cache.clear();
}

/** Substitutes `{{name}}` placeholders. Missing keys become an empty string. */
export function renderPrompt(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}
