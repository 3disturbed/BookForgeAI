import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { env } from '../domain/env.js';
import { belongsToProject } from '../domain/storage-paths.js';
import { NotAuthorizedError, NotFoundError } from '../domain/errors.js';

/**
 * Blob storage. The MVP writes to the local filesystem under DATA_DIR/blobs
 * using the same key layout as the S3 target in ARCHITECTURE.md, so swapping in
 * an S3 client is a change to this module only.
 *
 * SECURITY.md: user files are private; access is granted through short-lived
 * signed URLs rather than a public bucket.
 */
function blobRoot(): string {
  return resolve(env().DATA_DIR, 'blobs');
}

/** Rejects traversal and absolute keys before they reach the filesystem. */
function resolveKey(key: string): string {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\0')) {
    throw new NotAuthorizedError(`storage key "${key}"`);
  }
  const root = blobRoot();
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new NotAuthorizedError(`storage key "${key}"`);
  }
  return full;
}

export async function putBlob(key: string, data: Buffer | string): Promise<string> {
  const full = resolveKey(key);
  mkdirSync(dirname(full), { recursive: true });
  await writeFile(full, data);
  return key;
}

export async function getBlob(key: string): Promise<Buffer> {
  const full = resolveKey(key);
  if (!existsSync(full)) throw new NotFoundError(`blob ${key}`);
  return readFile(full);
}

export async function blobExists(key: string): Promise<boolean> {
  try {
    await stat(resolveKey(key));
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------- signing ---------------------------- */

/**
 * Signing secret. Regenerated per process when unset, which invalidates old
 * links on restart — acceptable for short-lived URLs, and a deployment should
 * set a stable secret.
 */
let signingSecret: Buffer | null = null;

function secret(): Buffer {
  if (signingSecret) return signingSecret;
  const configured = process.env.SIGNING_SECRET;
  signingSecret = configured ? Buffer.from(configured, 'utf8') : randomBytes(32);
  return signingSecret;
}

function sign(key: string, expiresAt: number): string {
  return createHmac('sha256', secret()).update(`${key}:${expiresAt}`).digest('hex');
}

export interface SignedUrl {
  url: string;
  expiresAt: number;
}

/** Mints a short-lived URL, scoped to one project's key prefix. */
export function signedUrlFor(key: string, projectId: string): SignedUrl {
  if (!belongsToProject(key, projectId)) {
    throw new NotAuthorizedError(`storage key "${key}"`);
  }
  const config = env();
  const expiresAt = Math.floor(Date.now() / 1000) + config.SIGNED_URL_TTL_SECONDS;
  const sig = sign(key, expiresAt);
  const params = new URLSearchParams({ key, exp: String(expiresAt), sig });
  return { url: `${config.APP_BASE_URL}/files?${params.toString()}`, expiresAt };
}

export function verifySignedUrl(key: string, exp: string, sig: string): boolean {
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;

  const expected = Buffer.from(sign(key, expiresAt), 'utf8');
  const provided = Buffer.from(sig, 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function localPathFor(key: string): string {
  return join(blobRoot(), key);
}
