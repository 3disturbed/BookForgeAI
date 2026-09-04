import { database, fromJson, nowIso, toJson } from './db.js';
import { newId } from '../domain/ids.js';
import type { ArtifactKind } from '../domain/artifacts.js';
import type { CoreEvent } from '../domain/events.js';
import type { StageId } from '../domain/pipeline.js';
import type { ApprovalGate, AssetStatus, AssetType, JobStatus, ProjectStatus, PublicationState } from '../domain/states.js';
import type { UsageRecord } from '../domain/costs.js';
import { EMPTY_USAGE } from '../domain/costs.js';

/* ----------------------------- users ----------------------------- */

export interface UserRow {
  id: string;
  email: string;
  createdAt: string;
}

export function upsertUser(email: string): UserRow {
  const db = database();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
    | Record<string, string>
    | undefined;
  if (existing) {
    return { id: existing.id!, email: existing.email!, createdAt: existing.created_at! };
  }
  const row: UserRow = { id: newId(), email, createdAt: nowIso() };
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    row.id, row.email, row.createdAt,
  );
  return row;
}

/* ---------------------------- projects ---------------------------- */

export interface ProjectRow {
  id: string;
  userId: string;
  title: string;
  idea: string;
  genre: string;
  audience: string;
  status: ProjectStatus;
  publicationState: PublicationState;
  completedStages: StageId[];
  revisionCycle: number;
  editionId: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapProject(r: Record<string, unknown>): ProjectRow {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    title: r.title as string,
    idea: r.idea as string,
    genre: (r.genre as string) ?? '',
    audience: (r.audience as string) ?? '',
    status: r.status as ProjectStatus,
    publicationState: r.publication_state as PublicationState,
    completedStages: fromJson<StageId[]>(r.completed_stages, []),
    revisionCycle: Number(r.revision_cycle ?? 0),
    editionId: (r.edition_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function createProject(input: {
  userId: string;
  title: string;
  idea: string;
  genre?: string;
  audience?: string;
}): ProjectRow {
  const db = database();
  const now = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO projects (id, user_id, title, idea, genre, audience, status,
       publication_state, completed_stages, revision_cycle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', 'DRAFT', '[]', 0, ?, ?)`,
  ).run(id, input.userId, input.title, input.idea, input.genre ?? '', input.audience ?? '', now, now);
  return getProject(id)!;
}

export function getProject(id: string): ProjectRow | null {
  const r = database().prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? mapProject(r) : null;
}

export function listProjects(userId: string): ProjectRow[] {
  const rows = database()
    .prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as Record<string, unknown>[];
  return rows.map(mapProject);
}

export function updateProject(
  id: string,
  patch: Partial<Pick<ProjectRow,
    'title' | 'genre' | 'audience' | 'status' | 'publicationState' |
    'completedStages' | 'revisionCycle' | 'editionId'>>,
): ProjectRow {
  const columns: Record<string, string> = {
    title: 'title',
    genre: 'genre',
    audience: 'audience',
    status: 'status',
    publicationState: 'publication_state',
    completedStages: 'completed_stages',
    revisionCycle: 'revision_cycle',
    editionId: 'edition_id',
  };

  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in patch)) continue;
    const raw = patch[key as keyof typeof patch];
    sets.push(`${column} = ?`);
    values.push(Array.isArray(raw) ? toJson(raw) : (raw as string | number | null));
  }
  if (sets.length === 0) return getProject(id)!;

  sets.push('updated_at = ?');
  values.push(nowIso(), id);
  database().prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getProject(id)!;
}

export function markStageComplete(projectId: string, stage: StageId): ProjectRow {
  const project = getProject(projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  if (project.completedStages.includes(stage)) return project;
  return updateProject(projectId, {
    completedStages: [...project.completedStages, stage],
  });
}

/* ---------------------------- artifacts --------------------------- */

export interface ArtifactRow<T = unknown> {
  id: string;
  projectId: string;
  kind: ArtifactKind;
  scopeKey: string | null;
  version: number;
  data: T;
  producedByJobId: string | null;
  createdAt: string;
}

function mapArtifact<T>(r: Record<string, unknown>): ArtifactRow<T> {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    kind: r.kind as ArtifactKind,
    scopeKey: (r.scope_key as string | null) ?? null,
    version: Number(r.version),
    data: fromJson<T>(r.data, {} as T),
    producedByJobId: (r.produced_by_job_id as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/** Writes a new immutable version. Artifacts are never updated in place. */
export function writeArtifact<T>(input: {
  projectId: string;
  kind: ArtifactKind;
  scopeKey?: string | null;
  data: T;
  producedByJobId?: string | null;
}): ArtifactRow<T> {
  const db = database();
  const scopeKey = input.scopeKey ?? null;
  const latest = db
    .prepare(
      `SELECT MAX(version) AS v FROM artifacts
       WHERE project_id = ? AND kind = ? AND scope_key IS ?`,
    )
    .get(input.projectId, input.kind, scopeKey) as { v: number | null } | undefined;

  const version = (latest?.v ?? 0) + 1;
  const id = newId();
  const createdAt = nowIso();

  db.prepare(
    `INSERT INTO artifacts
       (id, project_id, kind, scope_key, version, data, produced_by_job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.projectId, input.kind, scopeKey, version,
    toJson(input.data), input.producedByJobId ?? null, createdAt,
  );

  return {
    id,
    projectId: input.projectId,
    kind: input.kind,
    scopeKey,
    version,
    data: input.data,
    producedByJobId: input.producedByJobId ?? null,
    createdAt,
  };
}

export function latestArtifact<T>(
  projectId: string,
  kind: ArtifactKind,
  scopeKey: string | null = null,
): ArtifactRow<T> | null {
  const r = database()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ? AND scope_key IS ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(projectId, kind, scopeKey) as Record<string, unknown> | undefined;
  return r ? mapArtifact<T>(r) : null;
}

/** Latest version of every scope for a kind (e.g. all chapters). */
export function latestArtifactsOfKind<T>(
  projectId: string,
  kind: ArtifactKind,
): ArtifactRow<T>[] {
  const rows = database()
    .prepare(
      `SELECT a.* FROM artifacts a
       JOIN (
         SELECT scope_key, MAX(version) AS v FROM artifacts
         WHERE project_id = ? AND kind = ?
         GROUP BY scope_key
       ) m ON m.scope_key IS a.scope_key AND m.v = a.version
       WHERE a.project_id = ? AND a.kind = ?
       ORDER BY a.scope_key`,
    )
    .all(projectId, kind, projectId, kind) as Record<string, unknown>[];
  return rows.map((r) => mapArtifact<T>(r));
}

export function getArtifact<T>(id: string): ArtifactRow<T> | null {
  const r = database().prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? mapArtifact<T>(r) : null;
}

/* -------------------------- visual assets ------------------------- */

export interface VisualAssetRow {
  id: string;
  projectId: string;
  name: string;
  type: AssetType;
  status: AssetStatus;
  importance: string;
  canonicalDescription: Record<string, unknown>;
  referenceImageKeys: string[];
  version: number;
}

function mapAsset(r: Record<string, unknown>): VisualAssetRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    type: r.type as AssetType,
    status: r.status as AssetStatus,
    importance: (r.importance as string) ?? 'secondary',
    canonicalDescription: fromJson<Record<string, unknown>>(r.canonical_description, {}),
    referenceImageKeys: fromJson<string[]>(r.reference_image_keys, []),
    version: Number(r.version ?? 1),
  };
}

export function upsertVisualAsset(input: {
  projectId: string;
  name: string;
  type: AssetType;
  importance: string;
  canonicalDescription: Record<string, unknown>;
}): VisualAssetRow {
  const db = database();
  const now = nowIso();
  const existing = db
    .prepare('SELECT * FROM visual_assets WHERE project_id = ? AND name = ?')
    .get(input.projectId, input.name) as Record<string, unknown> | undefined;

  if (existing) {
    // A locked asset only changes through an explicit new version (VISUAL_CANON.md).
    if (existing.status === 'locked') return mapAsset(existing);
    db.prepare(
      `UPDATE visual_assets
       SET type = ?, importance = ?, canonical_description = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(input.type, input.importance, toJson(input.canonicalDescription), now, existing.id as string);
    return mapAsset(
      db.prepare('SELECT * FROM visual_assets WHERE id = ?').get(existing.id as string) as Record<string, unknown>,
    );
  }

  const id = newId();
  db.prepare(
    `INSERT INTO visual_assets
       (id, project_id, name, type, status, importance, canonical_description,
        reference_image_keys, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, '[]', 1, ?, ?)`,
  ).run(id, input.projectId, input.name, input.type, input.importance,
        toJson(input.canonicalDescription), now, now);
  return mapAsset(
    db.prepare('SELECT * FROM visual_assets WHERE id = ?').get(id) as Record<string, unknown>,
  );
}

export function listVisualAssets(projectId: string): VisualAssetRow[] {
  const rows = database()
    .prepare('SELECT * FROM visual_assets WHERE project_id = ? ORDER BY importance, name')
    .all(projectId) as Record<string, unknown>[];
  return rows.map(mapAsset);
}

export function setAssetStatus(id: string, status: AssetStatus): void {
  database()
    .prepare('UPDATE visual_assets SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, nowIso(), id);
}

export function addAssetReferenceImage(id: string, storageKey: string): void {
  const db = database();
  const row = db.prepare('SELECT reference_image_keys FROM visual_assets WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return;
  const keys = fromJson<string[]>(row.reference_image_keys, []);
  if (!keys.includes(storageKey)) keys.push(storageKey);
  db.prepare('UPDATE visual_assets SET reference_image_keys = ?, updated_at = ? WHERE id = ?')
    .run(toJson(keys), nowIso(), id);
}

/* ----------------------------- jobs ------------------------------ */

export interface JobRow {
  id: string;
  projectId: string;
  stage: StageId;
  agent: string;
  persona: string | null;
  scopeKey: string | null;
  status: JobStatus;
  round: number;
  /** Set while a retry is waiting out its backoff. */
  retryAfter: string | null;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  model: string | null;
  promptVersion: string | null;
  retryCount: number;
  usage: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function mapJob(r: Record<string, unknown>): JobRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    stage: r.stage as StageId,
    agent: r.agent as string,
    persona: (r.persona as string | null) ?? null,
    scopeKey: (r.scope_key as string | null) ?? null,
    status: r.status as JobStatus,
    round: Number(r.round ?? 0),
    retryAfter: (r.retry_after as string | null) ?? null,
    inputArtifactIds: fromJson<string[]>(r.input_artifact_ids, []),
    outputArtifactIds: fromJson<string[]>(r.output_artifact_ids, []),
    model: (r.model as string | null) ?? null,
    promptVersion: (r.prompt_version as string | null) ?? null,
    retryCount: Number(r.retry_count ?? 0),
    usage: fromJson<Record<string, unknown>>(r.usage, {}),
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

export function enqueueJob(input: {
  projectId: string;
  stage: StageId;
  agent: string;
  persona?: string | null;
  scopeKey?: string | null;
  round?: number;
}): JobRow {
  const db = database();
  const id = newId();
  db.prepare(
    `INSERT INTO agent_jobs
       (id, project_id, stage, agent, persona, scope_key, status, round, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(id, input.projectId, input.stage, input.agent,
        input.persona ?? null, input.scopeKey ?? null, input.round ?? 0, nowIso());
  return getJob(id)!;
}

/** Jobs for one stage/agent, optionally restricted to a revision round. */
export function jobsForAgent(
  projectId: string,
  stage: StageId,
  agent: string,
  round?: number,
): JobRow[] {
  const rows = (
    round === undefined
      ? database()
          .prepare(
            'SELECT * FROM agent_jobs WHERE project_id = ? AND stage = ? AND agent = ? ORDER BY created_at',
          )
          .all(projectId, stage, agent)
      : database()
          .prepare(
            `SELECT * FROM agent_jobs WHERE project_id = ? AND stage = ? AND agent = ? AND round = ?
             ORDER BY created_at`,
          )
          .all(projectId, stage, agent, round)
  ) as Record<string, unknown>[];
  return rows.map(mapJob);
}

/** Jobs still in flight for a stage, at a given round. */
export function activeJobsForStage(projectId: string, stage: StageId, round: number): JobRow[] {
  const rows = database()
    .prepare(
      `SELECT * FROM agent_jobs
       WHERE project_id = ? AND stage = ? AND round = ? AND status IN ('queued','running')`,
    )
    .all(projectId, stage, round) as Record<string, unknown>[];
  return rows.map(mapJob);
}

export function failedJobsForStage(projectId: string, stage: StageId, round: number): JobRow[] {
  const rows = database()
    .prepare(
      `SELECT * FROM agent_jobs
       WHERE project_id = ? AND stage = ? AND round = ? AND status IN ('failed','blocked')`,
    )
    .all(projectId, stage, round) as Record<string, unknown>[];
  return rows.map(mapJob);
}

export function getJob(id: string): JobRow | null {
  const r = database().prepare('SELECT * FROM agent_jobs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? mapJob(r) : null;
}

/** Claims the next queued job for a project, or any project when unscoped. */
export function claimNextJob(projectId?: string): JobRow | null {
  const db = database();
  const now = nowIso();
  const row = (
    projectId
      ? db.prepare(
          `SELECT * FROM agent_jobs WHERE status = 'queued' AND project_id = ?
             AND (retry_after IS NULL OR retry_after <= ?)
           ORDER BY created_at LIMIT 1`,
        ).get(projectId, now)
      : db.prepare(
          `SELECT * FROM agent_jobs WHERE status = 'queued'
             AND (retry_after IS NULL OR retry_after <= ?)
           ORDER BY created_at LIMIT 1`,
        ).get(now)
  ) as Record<string, unknown> | undefined;

  if (!row) return null;

  // Conditional update is the claim; a second worker racing here updates 0 rows.
  const result = db
    .prepare(`UPDATE agent_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`)
    .run(nowIso(), row.id as string);
  if (result.changes === 0) return null;

  return getJob(row.id as string);
}

export function completeJob(id: string, patch: {
  outputArtifactIds?: string[];
  model?: string | null;
  promptVersion?: string | null;
  usage?: Record<string, unknown>;
}): void {
  database().prepare(
    `UPDATE agent_jobs
     SET status = 'completed', output_artifact_ids = ?, model = ?, prompt_version = ?,
         usage = ?, finished_at = ?
     WHERE id = ?`,
  ).run(
    toJson(patch.outputArtifactIds ?? []), patch.model ?? null, patch.promptVersion ?? null,
    toJson(patch.usage ?? {}), nowIso(), id,
  );
}

/** Exponential backoff, so a network blip does not exhaust the budget at once. */
function backoffUntil(attempt: number): string {
  const seconds = Math.min(2 ** attempt * 5, 300);
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function failJob(id: string, error: string, retryable: boolean): void {
  const db = database();
  if (retryable) {
    const row = db.prepare('SELECT retry_count FROM agent_jobs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    const attempt = Number(row?.retry_count ?? 0) + 1;
    db.prepare(
      `UPDATE agent_jobs
       SET status = 'queued', retry_count = ?, error = ?, retry_after = ?, started_at = NULL
       WHERE id = ?`,
    ).run(attempt, error, backoffUntil(attempt), id);
    return;
  }
  db.prepare(`UPDATE agent_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
    .run(error, nowIso(), id);
}

/**
 * Puts failed and blocked jobs back in the queue with a fresh budget. Recovery
 * from an outage is otherwise impossible: a failed stage stalls the pipeline
 * permanently, and a restart only rescues jobs left mid-flight.
 */
export function retryFailedJobs(projectId: string, stage?: StageId): number {
  const db = database();
  const result = stage
    ? db.prepare(
        `UPDATE agent_jobs
         SET status = 'queued', retry_count = 0, retry_after = NULL,
             error = NULL, started_at = NULL, finished_at = NULL
         WHERE project_id = ? AND stage = ? AND status IN ('failed','blocked')`,
      ).run(projectId, stage)
    : db.prepare(
        `UPDATE agent_jobs
         SET status = 'queued', retry_count = 0, retry_after = NULL,
             error = NULL, started_at = NULL, finished_at = NULL
         WHERE project_id = ? AND status IN ('failed','blocked')`,
      ).run(projectId);
  return Number(result.changes);
}

export function blockJob(id: string, reason: string): void {
  database()
    .prepare(`UPDATE agent_jobs SET status = 'blocked', error = ?, finished_at = ? WHERE id = ?`)
    .run(reason, nowIso(), id);
}

export function listJobs(projectId: string, limit = 200): JobRow[] {
  const rows = database()
    .prepare('SELECT * FROM agent_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(mapJob);
}

export function countJobs(projectId: string): Record<JobStatus, number> {
  const rows = database()
    .prepare('SELECT status, COUNT(*) AS n FROM agent_jobs WHERE project_id = ? GROUP BY status')
    .all(projectId) as Record<string, unknown>[];
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, blocked: 0 };
  for (const r of rows) counts[r.status as JobStatus] = Number(r.n);
  return counts;
}

export function hasPendingWork(projectId: string): boolean {
  const c = countJobs(projectId);
  return c.queued > 0 || c.running > 0;
}

/* ---------------------------- events ----------------------------- */

export function recordEvent(input: {
  projectId: string;
  type: CoreEvent;
  actor: string;
  payload?: Record<string, unknown>;
}): void {
  database().prepare(
    'INSERT INTO events (id, project_id, type, actor, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(newId(), input.projectId, input.type, input.actor, toJson(input.payload ?? {}), nowIso());
}

export interface EventRow {
  id: string;
  type: CoreEvent;
  actor: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export function listEvents(projectId: string, limit = 100): EventRow[] {
  const rows = database()
    .prepare('SELECT * FROM events WHERE project_id = ? ORDER BY occurred_at DESC LIMIT ?')
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    type: r.type as CoreEvent,
    actor: r.actor as string,
    payload: fromJson<Record<string, unknown>>(r.payload, {}),
    occurredAt: r.occurred_at as string,
  }));
}

/* --------------------------- approvals --------------------------- */

export function setApproval(input: {
  projectId: string;
  gate: ApprovalGate;
  approved: boolean;
  actor: string;
  note?: string;
}): void {
  database().prepare(
    `INSERT INTO approvals (id, project_id, gate, approved, actor, note, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, gate) DO UPDATE SET
       approved = excluded.approved, actor = excluded.actor,
       note = excluded.note, decided_at = excluded.decided_at`,
  ).run(newId(), input.projectId, input.gate, input.approved ? 1 : 0,
        input.actor, input.note ?? '', nowIso());
}

export function listApprovals(projectId: string): Record<string, boolean> {
  const rows = database()
    .prepare('SELECT gate, approved FROM approvals WHERE project_id = ?')
    .all(projectId) as Record<string, unknown>[];
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.gate as string] = Number(r.approved) === 1;
  return out;
}

export function isGateApproved(projectId: string, gate: ApprovalGate): boolean {
  return listApprovals(projectId)[gate] === true;
}

/* ---------------------------- payments ---------------------------- */

export interface PaymentRow {
  id: string;
  projectId: string;
  provider: string;
  sessionId: string | null;
  amountCents: number;
  currency: string;
  status: string;
  confirmedAt: string | null;
}

function mapPayment(r: Record<string, unknown>): PaymentRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    provider: r.provider as string,
    sessionId: (r.session_id as string | null) ?? null,
    amountCents: Number(r.amount_cents),
    currency: r.currency as string,
    status: r.status as string,
    confirmedAt: (r.confirmed_at as string | null) ?? null,
  };
}

export function createPayment(input: {
  projectId: string;
  provider: string;
  sessionId: string | null;
  amountCents: number;
  currency: string;
}): PaymentRow {
  const id = newId();
  database().prepare(
    `INSERT INTO payments (id, project_id, provider, session_id, amount_cents, currency, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, input.projectId, input.provider, input.sessionId,
        input.amountCents, input.currency, nowIso());
  return mapPayment(
    database().prepare('SELECT * FROM payments WHERE id = ?').get(id) as Record<string, unknown>,
  );
}

/** Idempotent: a replayed webhook confirms once (ARCHITECTURE.md). */
export function confirmPaymentBySession(sessionId: string): PaymentRow | null {
  const db = database();
  const row = db.prepare('SELECT * FROM payments WHERE session_id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  if (row.status !== 'confirmed') {
    db.prepare(`UPDATE payments SET status = 'confirmed', confirmed_at = ? WHERE id = ?`)
      .run(nowIso(), row.id as string);
  }
  return mapPayment(
    db.prepare('SELECT * FROM payments WHERE id = ?').get(row.id as string) as Record<string, unknown>,
  );
}

export function latestPayment(projectId: string): PaymentRow | null {
  const r = database()
    .prepare('SELECT * FROM payments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(projectId) as Record<string, unknown> | undefined;
  return r ? mapPayment(r) : null;
}

export function isPaymentConfirmed(projectId: string): boolean {
  const r = database()
    .prepare(`SELECT 1 AS ok FROM payments WHERE project_id = ? AND status = 'confirmed' LIMIT 1`)
    .get(projectId) as Record<string, unknown> | undefined;
  return Boolean(r);
}

/* ---------------------------- editions ---------------------------- */

export interface EditionRow {
  id: string;
  projectId: string;
  editionNumber: number;
  title: string;
  blurb: string;
  frozenArtifacts: string[];
  pdfStorageKey: string;
  publishedAt: string | null;
}

function mapEdition(r: Record<string, unknown>): EditionRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    editionNumber: Number(r.edition_number),
    title: r.title as string,
    blurb: (r.blurb as string) ?? '',
    frozenArtifacts: fromJson<string[]>(r.frozen_artifacts, []),
    pdfStorageKey: (r.pdf_storage_key as string) ?? '',
    publishedAt: (r.published_at as string | null) ?? null,
  };
}

export function createEdition(input: {
  projectId: string;
  title: string;
  blurb: string;
  frozenArtifacts: string[];
  pdfStorageKey: string;
}): EditionRow {
  const db = database();
  const prev = db
    .prepare('SELECT MAX(edition_number) AS n FROM editions WHERE project_id = ?')
    .get(input.projectId) as { n: number | null } | undefined;
  const id = newId();
  db.prepare(
    `INSERT INTO editions
       (id, project_id, edition_number, title, blurb, frozen_artifacts, pdf_storage_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.projectId, (prev?.n ?? 0) + 1, input.title, input.blurb,
        toJson(input.frozenArtifacts), input.pdfStorageKey, nowIso());
  return mapEdition(
    db.prepare('SELECT * FROM editions WHERE id = ?').get(id) as Record<string, unknown>,
  );
}

export function markEditionPublished(id: string): void {
  database().prepare('UPDATE editions SET published_at = ? WHERE id = ?').run(nowIso(), id);
}

export function getEdition(id: string): EditionRow | null {
  const r = database().prepare('SELECT * FROM editions WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? mapEdition(r) : null;
}

/* ----------------------------- usage ------------------------------ */

export function recordUsage(input: {
  projectId: string;
  jobId: string | null;
  usage: Partial<UsageRecord>;
}): void {
  database().prepare(
    `INSERT INTO usage_ledger
       (id, project_id, job_id, text_input_tokens, text_output_tokens,
        image_generations, image_input_images, compute_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(), input.projectId, input.jobId,
    input.usage.textInputTokens ?? 0, input.usage.textOutputTokens ?? 0,
    input.usage.imageGenerations ?? 0, input.usage.imageInputImages ?? 0,
    input.usage.computeSeconds ?? 0, nowIso(),
  );
}

export function totalUsage(projectId: string): UsageRecord {
  const r = database().prepare(
    `SELECT
       COALESCE(SUM(text_input_tokens), 0)  AS ti,
       COALESCE(SUM(text_output_tokens), 0) AS to_,
       COALESCE(SUM(image_generations), 0)  AS ig,
       COALESCE(SUM(image_input_images), 0) AS ii,
       COALESCE(SUM(compute_seconds), 0)    AS cs
     FROM usage_ledger WHERE project_id = ?`,
  ).get(projectId) as Record<string, unknown> | undefined;

  if (!r) return { ...EMPTY_USAGE };
  return {
    textInputTokens: Number(r.ti ?? 0),
    textOutputTokens: Number(r.to_ ?? 0),
    imageGenerations: Number(r.ig ?? 0),
    imageInputImages: Number(r.ii ?? 0),
    storageGbMonths: 0,
    computeSeconds: Number(r.cs ?? 0),
  };
}

/**
 * Requeues jobs left mid-flight by a crash or restart. A job marked `running`
 * has no worker behind it once the process is gone, so it would block its stage
 * forever. Jobs that have already exhausted their retries are failed instead.
 */
export function requeueStaleJobs(maxRetries = 2): number {
  const db = database();
  const stale = db
    .prepare(`SELECT id, retry_count FROM agent_jobs WHERE status = 'running'`)
    .all() as Record<string, unknown>[];

  for (const row of stale) {
    const id = row.id as string;
    if (Number(row.retry_count ?? 0) >= maxRetries) {
      db.prepare(
        `UPDATE agent_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      ).run('Interrupted by restart, retries exhausted', nowIso(), id);
    } else {
      db.prepare(
        `UPDATE agent_jobs SET status = 'queued', retry_count = retry_count + 1,
         error = 'Requeued after restart', started_at = NULL WHERE id = ?`,
      ).run(id);
    }
  }
  return stale.length;
}

/** Projects that still have pipeline work to do, for restart recovery. */
export function allActiveProjectIds(): string[] {
  const rows = database()
    .prepare(`SELECT id FROM projects WHERE publication_state != 'PUBLISHED'`)
    .all() as Record<string, unknown>[];
  return rows.map((r) => r.id as string);
}
