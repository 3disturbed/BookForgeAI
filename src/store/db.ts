import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from '../domain/env.js';

/**
 * Canonical project state (ARCHITECTURE.md). The MVP ships SQLite so the
 * service runs with no external database; the accessor surface below is the
 * seam a Postgres implementation would replace.
 */
let db: DatabaseSync | null = null;

export function database(): DatabaseSync {
  if (db) return db;

  const file = resolve(env().DATA_DIR, 'bookforge.db');
  mkdirSync(dirname(file), { recursive: true });

  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

function migrate(conn: DatabaseSync): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL REFERENCES users(id),
      title              TEXT NOT NULL,
      idea               TEXT NOT NULL,
      genre              TEXT NOT NULL DEFAULT '',
      audience           TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'draft',
      publication_state  TEXT NOT NULL DEFAULT 'DRAFT',
      completed_stages   TEXT NOT NULL DEFAULT '[]',
      revision_cycle     INTEGER NOT NULL DEFAULT 0,
      edition_id         TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);

    -- Versioned, immutable artifacts. One row per (project, kind, scope, version).
    CREATE TABLE IF NOT EXISTS artifacts (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind               TEXT NOT NULL,
      scope_key          TEXT,
      version            INTEGER NOT NULL,
      data               TEXT NOT NULL,
      produced_by_job_id TEXT,
      created_at         TEXT NOT NULL,
      UNIQUE (project_id, kind, scope_key, version)
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_lookup
      ON artifacts(project_id, kind, scope_key, version DESC);

    CREATE TABLE IF NOT EXISTS visual_assets (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name                  TEXT NOT NULL,
      type                  TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'draft',
      importance            TEXT NOT NULL DEFAULT 'secondary',
      canonical_description TEXT NOT NULL DEFAULT '{}',
      reference_image_keys  TEXT NOT NULL DEFAULT '[]',
      version               INTEGER NOT NULL DEFAULT 1,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      UNIQUE (project_id, name)
    );

    CREATE TABLE IF NOT EXISTS agent_jobs (
      id                  TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      stage               TEXT NOT NULL,
      agent               TEXT NOT NULL,
      persona             TEXT,
      scope_key           TEXT,
      status              TEXT NOT NULL DEFAULT 'queued',
      round               INTEGER NOT NULL DEFAULT 0,
      -- Earliest time a requeued job may be claimed, so a transient outage
      -- does not burn the whole retry budget in a second.
      retry_after         TEXT,
      input_artifact_ids  TEXT NOT NULL DEFAULT '[]',
      output_artifact_ids TEXT NOT NULL DEFAULT '[]',
      model               TEXT,
      prompt_version      TEXT,
      retry_count         INTEGER NOT NULL DEFAULT 0,
      usage               TEXT NOT NULL DEFAULT '{}',
      error               TEXT,
      created_at          TEXT NOT NULL,
      started_at          TEXT,
      finished_at         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON agent_jobs(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON agent_jobs(status);

    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      actor       TEXT NOT NULL,
      payload     TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, occurred_at);

    -- Human approval gates (SDD.md §6). Audited per SECURITY.md.
    CREATE TABLE IF NOT EXISTS approvals (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      gate        TEXT NOT NULL,
      approved    INTEGER NOT NULL DEFAULT 0,
      actor       TEXT NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      decided_at  TEXT NOT NULL,
      UNIQUE (project_id, gate)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider     TEXT NOT NULL,
      session_id   TEXT UNIQUE,
      amount_cents INTEGER NOT NULL,
      currency     TEXT NOT NULL,
      status       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      confirmed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS editions (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      edition_number  INTEGER NOT NULL,
      title           TEXT NOT NULL,
      blurb           TEXT NOT NULL DEFAULT '',
      frozen_artifacts TEXT NOT NULL DEFAULT '[]',
      pdf_storage_key TEXT NOT NULL DEFAULT '',
      published_at    TEXT,
      created_at      TEXT NOT NULL,
      UNIQUE (project_id, edition_number)
    );

    -- Idempotency ledger for jobs and payment webhooks (ARCHITECTURE.md).
    CREATE TABLE IF NOT EXISTS idempotency (
      key        TEXT PRIMARY KEY,
      result     TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    -- One row per attempt that spent money, successful or not. Columns after
    -- created_at were added later and are also listed in ADDED_COLUMNS so an
    -- existing database receives them.
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      job_id                TEXT,
      text_input_tokens     INTEGER NOT NULL DEFAULT 0,
      text_output_tokens    INTEGER NOT NULL DEFAULT 0,
      image_generations     INTEGER NOT NULL DEFAULT 0,
      image_input_images    INTEGER NOT NULL DEFAULT 0,
      compute_seconds       REAL    NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL,
      agent                 TEXT,
      capability            TEXT,
      provider              TEXT NOT NULL DEFAULT 'openai',
      model                 TEXT,
      mode                  TEXT NOT NULL DEFAULT 'sync',
      status                TEXT NOT NULL DEFAULT 'completed',
      cached_input_tokens   INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
      model_calls           INTEGER NOT NULL DEFAULT 0,
      image_input_tokens    INTEGER NOT NULL DEFAULT 0,
      image_text_input_tokens INTEGER NOT NULL DEFAULT 0,
      image_output_tokens   INTEGER NOT NULL DEFAULT 0,
      image_calls           INTEGER NOT NULL DEFAULT 0,
      batched_input_tokens  INTEGER NOT NULL DEFAULT 0,
      batched_output_tokens INTEGER NOT NULL DEFAULT 0,
      model_latency_seconds REAL    NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_ledger(project_id);
  `);

  applyColumnMigrations(conn);
}

/**
 * Additive column migrations. `CREATE TABLE IF NOT EXISTS` silently does
 * nothing on an existing database, so a column added to the schema above never
 * reaches a database created before it. Every such column is listed here.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'agent_jobs', column: 'round', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'agent_jobs', column: 'retry_after', definition: 'TEXT' },
  // Cost attribution: who spent it, on what, how, and whether it bought anything.
  { table: 'usage_ledger', column: 'agent', definition: 'TEXT' },
  { table: 'usage_ledger', column: 'capability', definition: 'TEXT' },
  { table: 'usage_ledger', column: 'provider', definition: "TEXT NOT NULL DEFAULT 'openai'" },
  { table: 'usage_ledger', column: 'model', definition: 'TEXT' },
  { table: 'usage_ledger', column: 'mode', definition: "TEXT NOT NULL DEFAULT 'sync'" },
  { table: 'usage_ledger', column: 'status', definition: "TEXT NOT NULL DEFAULT 'completed'" },
  { table: 'usage_ledger', column: 'cached_input_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'usage_ledger', column: 'reasoning_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'usage_ledger', column: 'model_calls', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'usage_ledger', column: 'image_input_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'usage_ledger', column: 'image_text_input_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'usage_ledger', column: 'image_output_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'usage_ledger', column: 'image_calls', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'usage_ledger', column: 'batched_input_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'usage_ledger', column: 'batched_output_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'usage_ledger', column: 'model_latency_seconds', definition: 'REAL NOT NULL DEFAULT 0' },
];

/** Exported so a test can prove an old database gains every listed column. */
export function applyColumnMigrations(conn: DatabaseSync): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const existing = conn.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    if (existing.length === 0) continue; // table not created yet
    if (existing.some((c) => c.name === column)) continue;
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const nowIso = (): string => new Date().toISOString();

/** SQLite stores JSON as text; these keep the casts in one place. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
