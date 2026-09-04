/**
 * Canonical spellings, enforced rather than requested.
 *
 * A decision like "the ship is Mapado, not Manado" loses to the model's own
 * lexical prior: Manado is a real place, so it is written back regardless of
 * instruction, and once it reaches the knowledge map every later agent inherits
 * it as canon. Spelling is therefore fixed on the way into storage, the same
 * way em dashes and word counts are.
 */
export interface TermCorrection {
  /** The spelling that must not appear. */
  wrong: string;
  /** The spelling that replaces it. */
  right: string;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words that start a sentence or are otherwise not names. */
const NOT_A_NAME = new Set([
  'confirm', 'should', 'the', 'a', 'an', 'do', 'does', 'is', 'are', 'what', 'which',
  'how', 'why', 'when', 'where', 'who', 'level', 'use', 'keep', 'name', 'or', 'and',
  'either', 'spelling', 'yes', 'no', 'we', 'i', 'it', 'this', 'that',
]);

/**
 * Reads corrections out of an answered question.
 *
 * "Confirm the ship's name spelling: Mapado or Manado." answered "Mapado"
 * yields Manado -> Mapado: the answer names the survivor, and the other
 * capitalised alternatives in the question are what it replaces.
 */
export function deriveCorrections(question: string, answer: string): TermCorrection[] {
  const chosen = answer.trim();
  // Only a short, name-shaped answer identifies a spelling. A paragraph does not.
  if (!chosen || chosen.split(/\s+/).length > 3) return [];
  if (!new RegExp(`\\b${escapeRegExp(chosen)}\\b`).test(question)) return [];

  const alternatives = (question.match(/\b[A-Z][A-Za-z'’-]{2,}\b/g) ?? [])
    .filter((word) => word !== chosen)
    .filter((word) => !NOT_A_NAME.has(word.toLowerCase()))
    // A word the answer contains, or that contains it, is a variant not a rival.
    .filter((word) => word.toLowerCase() !== chosen.toLowerCase());

  return [...new Set(alternatives)].map((wrong) => ({ wrong, right: chosen }));
}

/** Applies corrections to one string, preserving word boundaries. */
export function applyCorrections(text: string, corrections: readonly TermCorrection[]): string {
  let out = text;
  for (const { wrong, right } of corrections) {
    if (!wrong || wrong === right) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(wrong)}\\b`, 'g'), right);
  }
  return out;
}

/** Applies corrections to every string in a structure, at any depth. */
export function applyCorrectionsDeep<T>(value: T, corrections: readonly TermCorrection[]): T {
  if (corrections.length === 0) return value;
  if (typeof value === 'string') return applyCorrections(value, corrections) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => applyCorrectionsDeep(v, corrections)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = applyCorrectionsDeep(inner, corrections);
    }
    return out as T;
  }
  return value;
}

export function countOccurrences(value: unknown, term: string): number {
  const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g');
  const walk = (v: unknown): number => {
    if (typeof v === 'string') return (v.match(pattern) ?? []).length;
    if (Array.isArray(v)) return v.reduce((n: number, x) => n + walk(x), 0);
    if (v && typeof v === 'object') {
      return Object.values(v as Record<string, unknown>).reduce((n: number, x) => n + walk(x), 0);
    }
    return 0;
  };
  return walk(value);
}
