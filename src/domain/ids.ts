import { randomUUID } from 'node:crypto';

/** Public identifiers are UUIDs (DATA_MODEL.md). */
export type Uuid = string;

export function newId(): Uuid {
  return randomUUID();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Stable, human-readable key for per-chapter / per-asset / per-scene scoping. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
