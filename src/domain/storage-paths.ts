/** ARCHITECTURE.md — object storage layout. */
export const STORAGE_PREFIXES = [
  'manuscript', 'research', 'assets', 'illustrations', 'covers', 'renders', 'exports',
] as const;

export type StoragePrefix = (typeof STORAGE_PREFIXES)[number];

/**
 * Keys are always rooted at the project, so a signed URL can never be minted
 * outside the caller's own project scope (SECURITY.md).
 */
export function storageKey(projectId: string, prefix: StoragePrefix, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `projects/${projectId}/${prefix}/${safe}`;
}

export function projectPrefix(projectId: string): string {
  return `projects/${projectId}/`;
}

/** Stops a key from one project being replayed against another. */
export function belongsToProject(key: string, projectId: string): boolean {
  return key.startsWith(projectPrefix(projectId));
}
