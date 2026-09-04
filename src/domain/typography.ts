/**
 * House style: no em dashes in generated text.
 *
 * Prompt instructions alone do not hold — models reintroduce the character
 * regardless — so the rule is enforced on every artifact before it is
 * committed, the same way chapter word counts are derived rather than trusted.
 */

/** Punctuation that already terminates a clause, so a comma must not follow. */
const TRAILING_PUNCTUATION = /[,;:.!?]$/;

/**
 * Rewrites a dash used as punctuation into a comma, choosing the form that
 * leaves the sentence readable:
 *
 * - `pack—Swords`        -> `pack, Swords`
 * - `stance — humility`  -> `stance, humility`
 * - `yes,—but`           -> `yes, but`        (no doubled punctuation)
 * - `"I said—"`          -> `"I said"`        (interruption, comma would be wrong)
 * - `1870–1970`          -> unchanged         (a range, not punctuation)
 */
export function stripEmDashes(text: string): string {
  if (!text) return text;

  let out = text
    // Em dash, and the ASCII double-hyphen models use in its place. A spaced en
    // dash is punctuation too; an unspaced one is a numeric or date range and
    // is left alone.
    .replace(/\s*(?:—|--|\s–\s)\s*/g, (match, offset: number, whole: string) => {
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);

      // Trailing dash: an interruption or a dangling clause. Drop it.
      if (after === '' || /^["'”’)\]]/.test(after)) return '';
      // Leading dash: a list marker or stray opener. Drop it.
      if (before.trim() === '') return '';
      // Already punctuated: do not stack a second mark.
      if (TRAILING_PUNCTUATION.test(before.trimEnd())) return ' ';
      return ', ';
    });

  // Tidy anything the substitution left behind.
  out = out
    .replace(/ {2,}/g, ' ')
    .replace(/\s+([,;:.!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .trimEnd();

  return out;
}

export function containsEmDash(text: string): boolean {
  return /—|--|\s–\s/.test(text);
}

/**
 * Applies the rule to every string in an artifact, at any depth, so it reaches
 * chapter prose, headings, captions, blurbs and anything else bound for the PDF.
 */
export function stripEmDashesDeep<T>(value: T): T {
  if (typeof value === 'string') return stripEmDashes(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => stripEmDashesDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = stripEmDashesDeep(inner);
    }
    return out as T;
  }
  return value;
}

/** Counts remaining offenders, for verifying a corpus. */
export function countEmDashes(value: unknown): number {
  if (typeof value === 'string') return (value.match(/—|--|\s–\s/g) ?? []).length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + countEmDashes(v), 0);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .reduce((n: number, v) => n + countEmDashes(v), 0);
  }
  return 0;
}
