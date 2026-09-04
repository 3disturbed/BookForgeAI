import { agentDefinition, type AgentName } from '../domain/agents.js';
import { env } from '../domain/env.js';
import { slug } from '../domain/ids.js';
import {
  ORDERED_STAGES, revisionDecision, STAGES, type StageDefinition, type StageId,
} from '../domain/pipeline.js';
import { storageKey } from '../domain/storage-paths.js';
import type { ApprovalGate, ProjectStatus } from '../domain/states.js';
import { putBlob } from '../storage/blobs.js';
import { renderPdf, type PageModel } from '../pdf/render.js';
import { allScenes, chapterScope, runJob } from '../agents/runner.js';
import * as repo from '../store/repo.js';

/** Stages that re-run each time the editorial loop goes round (SDD.md §7). */
const LOOP_STAGES: ReadonlySet<StageId> = new Set(['criticise', 'diagnose', 'rewrite']);


interface PlannedJob {
  scopeKey: string | null;
  persona?: string;
}

function roundFor(project: repo.ProjectRow, stage: StageId): number {
  return LOOP_STAGES.has(stage) ? project.revisionCycle : 0;
}

/** A dependency only unblocks once its human approval gate has been given. */
function dependenciesSatisfied(project: repo.ProjectRow, stage: StageDefinition): boolean {
  const complete = new Set(project.completedStages);
  return stage.dependsOn.every((dep) => {
    if (!complete.has(dep)) return false;
    const gate = STAGES[dep].gate;
    return !gate || repo.isGateApproved(project.id, gate);
  });
}

/* ------------------------------ fan-out ----------------------------- */

function chapterNumbers(projectId: string): number[] {
  const outline = repo.latestArtifact<{ chapters: { number: number }[] }>(projectId, 'outline');
  return (outline?.data.chapters ?? []).map((c) => c.number).sort((a, b) => a - b);
}

function planJobs(project: repo.ProjectRow, agent: AgentName, round = 0): PlannedJob[] {
  const def = agentDefinition(agent);

  switch (def.cardinality) {
    case 'single':
      return [{ scopeKey: null }];

    case 'chapter': {
      // After the first round, critics and diagnosis re-read only the chapters
      // whose previous diagnosis carried an issue worth a full critique pass.
      // Every other chapter keeps its last critique; re-reading it would cost
      // five critic calls to learn nothing the loop asked for.
      const chapters = round > 0 && (agent === 'critics' || agent === 'diagnosis')
        ? chaptersToReread(project, round - 1)
        : chapterNumbers(project.id);
      const scoped = chapters.map((n) => ({ scopeKey: chapterScope(n) }));
      if (!def.personas) return scoped;
      // Critics fan out across chapters and personas.
      return scoped.flatMap((c) => def.personas!.map((persona) => ({ ...c, persona })));
    }

    case 'asset':
      // Background props get no reference sheet: on the measured runs scenes
      // never called for one, so the render bought no drift control. Their
      // canon still reaches the director and QA as text.
      return repo
        .listVisualAssets(project.id)
        .filter((a) => a.status !== 'retired' && a.importance !== 'background')
        .map((a) => ({ scopeKey: slug(a.name) }));

    case 'scene': {
      const scenes = allScenes(project.id).map((s) => ({ scopeKey: s.key }));
      // QA can only judge a render that exists; a refused image has none.
      if (agent !== 'visual-qa') return scenes;
      const rendered = new Set(
        repo.latestArtifactsOfKind<{ sceneKey: string }>(project.id, 'artwork')
          .map((a) => a.data.sceneKey),
      );
      return scenes.filter((s) => s.scopeKey && rendered.has(s.scopeKey));
    }
  }
}

const SEVERITY_RANK: Record<string, number> = { critical: 2, major: 1, minor: 0 };

/** Issues at or above this rank send a rewritten chapter back to the critics. */
function rereadThreshold(): number {
  return SEVERITY_RANK[env().REVISION_REREAD_SEVERITY] ?? 2;
}

interface RewrittenDiagnosis {
  chapter: number;
  tasks: { severity: string }[];
}

/**
 * The diagnoses that drove this round's completed rewrites, one per chapter.
 * Built from job rows and the artifacts they produced, both immutable, so the
 * answer cannot drift while the next round's diagnoses are being written.
 */
function rewrittenDiagnoses(project: repo.ProjectRow, round: number): RewrittenDiagnosis[] {
  const rewritten = new Set(
    repo.jobsForAgent(project.id, 'rewrite', 'rewriter', round)
      .filter((j) => j.status === 'completed' && j.scopeKey)
      .map((j) => j.scopeKey!),
  );

  // Keyed by scope so a retried job row cannot count a chapter twice.
  const byScope = new Map<string, RewrittenDiagnosis>();
  for (const job of repo.jobsForAgent(project.id, 'diagnose', 'diagnosis', round)) {
    if (job.status !== 'completed' || !job.scopeKey || !rewritten.has(job.scopeKey)) continue;
    const diagnosis = repo.getArtifact<{ tasks?: { severity: string }[] }>(job.outputArtifactIds[0] ?? '');
    if (!diagnosis) continue;
    byScope.set(job.scopeKey, {
      chapter: Number(job.scopeKey.replace(/^ch/, '')),
      tasks: diagnosis.data.tasks ?? [],
    });
  }
  return [...byScope.values()].sort((a, b) => a.chapter - b.chapter);
}

/**
 * Chapters rewritten in `round` whose driving diagnosis carried an issue at
 * or above the re-read severity.
 */
function chaptersToReread(project: repo.ProjectRow, round: number): number[] {
  const threshold = rereadThreshold();
  return rewrittenDiagnoses(project, round)
    .filter((d) => d.tasks.some((t) => (SEVERITY_RANK[t.severity] ?? 0) >= threshold))
    .map((d) => d.chapter);
}

/** Critical tasks among the diagnoses that drove this round's rewrites. */
function openCriticalTasks(project: repo.ProjectRow, round: number): number {
  return rewrittenDiagnoses(project, round).reduce(
    (n, d) => n + d.tasks.filter((t) => t.severity === 'critical').length,
    0,
  );
}

/**
 * Only rewrites chapters that this round's diagnosis actually flagged. Planned
 * from the round's completed diagnosis jobs, not from the latest artifact per
 * chapter: a chapter rewritten in an earlier round and not re-read keeps its
 * old `revise` verdict as its latest artifact, and planning from that would
 * rewrite it again every round for tasks the first rewrite already answered.
 */
function planRewrites(project: repo.ProjectRow, round: number): PlannedJob[] {
  const scopes = new Set<string>();
  for (const job of repo.jobsForAgent(project.id, 'diagnose', 'diagnosis', round)) {
    if (job.status !== 'completed' || !job.scopeKey) continue;
    const diagnosis = repo.getArtifact<{ verdict?: string }>(job.outputArtifactIds[0] ?? '');
    if (diagnosis?.data.verdict === 'revise') scopes.add(job.scopeKey);
  }
  return [...scopes].map((scopeKey) => ({ scopeKey }));
}

function keyOf(job: { scopeKey: string | null; persona?: string | null }): string {
  return `${job.scopeKey ?? ''}|${job.persona ?? ''}`;
}

/* --------------------------- stage advance -------------------------- */

/**
 * Idempotent scheduler. Walks the pipeline, enqueues whatever the project is
 * ready for, and stops at the first stage still waiting on work or approval.
 */
export function advanceProject(projectId: string): void {
  let project = repo.getProject(projectId);
  if (!project) return;
  if (project.publicationState === 'PUBLISHED') return;

  for (const stage of ORDERED_STAGES) {
    if (project.completedStages.includes(stage.id)) continue;
    if (!dependenciesSatisfied(project, stage)) return;

    // Illustration is optional; skipping it leaves a text-only book.
    if (stage.id === 'illustrate' && !env().ENABLE_ILLUSTRATIONS) {
      project = completeStage(project, stage);
      continue;
    }
    // `publish` has no agents: it waits on payment plus the approval gate.
    if (stage.agents.length === 0) {
      if (stage.id === 'publish' && !repo.isPaymentConfirmed(project.id)) return;
      project = completeStage(project, stage);
      continue;
    }

    const round = roundFor(project, stage.id);
    if (repo.activeJobsForStage(project.id, stage.id, round).length > 0) return;

    // A failed best-effort job costs the book an illustration, not the run.
    const failures = repo
      .failedJobsForStage(project.id, stage.id, round)
      .filter((job) => !agentDefinition(job.agent as AgentName).optional);

    if (failures.length > 0) {
      setStatus(project.id, 'review');
      return;
    }

    let enqueued = false;
    for (const agent of stage.agents) {
      const existing = repo.jobsForAgent(project.id, stage.id, agent, round);
      const seen = new Set(existing.map(keyOf));

      const planned =
        agent === 'rewriter' ? planRewrites(project, round) : planJobs(project, agent, round);
      const missing = planned.filter((p) => !seen.has(keyOf(p)));

      if (missing.length > 0) {
        for (const job of missing) {
          repo.enqueueJob({
            projectId: project.id,
            stage: stage.id,
            agent,
            scopeKey: job.scopeKey,
            persona: job.persona ?? null,
            round,
          });
        }
        enqueued = true;
        break;
      }

      // No work for this agent at all (e.g. nothing to rewrite): move on.
      if (existing.length === 0) continue;

      const settled = agentDefinition(agent).optional
        ? (j: repo.JobRow) => j.status === 'completed' || j.status === 'failed' || j.status === 'blocked'
        : (j: repo.JobRow) => j.status === 'completed';
      if (!existing.every(settled)) return;
    }

    if (enqueued) {
      setStatus(project.id, 'forging');
      return;
    }

    // Regeneration keeps the illustrate stage open until QA is satisfied.
    if (stage.id === 'illustrate' && enqueueRegenerations(project)) {
      return;
    }

    project = completeStage(project, stage);

    // SDD.md §7 orders the loop CRITICS -> DIAGNOSIS -> REWRITE -> CRITICS, so
    // the decision belongs after the rewrite, not after the diagnosis. Deciding
    // earlier skipped the rewrite entirely.
    if (stage.id === 'rewrite') {
      if (applyRevisionDecision(project)) {
        // Reopening the loop stages queues nothing by itself; re-enter the
        // scheduler so the next round's critics are enqueued.
        advanceProject(projectId);
        return;
      }
      project = repo.getProject(projectId)!;
    }
  }

  setStatus(project.id, project.publicationState === 'PUBLISHED' ? 'published' : 'review');
}

function completeStage(project: repo.ProjectRow, stage: StageDefinition): repo.ProjectRow {
  const updated = repo.markStageComplete(project.id, stage.id);
  runStageHooks(updated, stage);
  return repo.getProject(project.id) ?? updated;
}

function setStatus(projectId: string, status: ProjectStatus): void {
  const project = repo.getProject(projectId);
  if (!project || project.status === status) return;
  // Never walk a paid or published project back to an earlier status.
  if (['publishing', 'published'].includes(project.status)) return;
  repo.updateProject(projectId, { status });
}

/* ---------------------------- approvals ----------------------------- */

const GATE_EVENTS: Partial<Record<ApprovalGate, string>> = {
  architecture: 'ARCHITECTURE_APPROVED',
  outline: 'OUTLINE_APPROVED',
  manuscript: 'MANUSCRIPT_APPROVED',
  visual_canon: 'VISUAL_ASSET_APPROVED',
  key_illustrations: 'ILLUSTRATION_APPROVED',
};

/**
 * Records a human decision at an approval gate and applies whatever that
 * decision means for the project. Every caller goes through here so the side
 * effects cannot be skipped by reaching setApproval directly.
 */
export function applyApproval(input: {
  projectId: string;
  gate: ApprovalGate;
  approved: boolean;
  actor: string;
  note?: string;
}): void {
  repo.setApproval({
    projectId: input.projectId,
    gate: input.gate,
    approved: input.approved,
    actor: input.actor,
    note: input.note ?? '',
  });

  if (input.approved) {
    const event = GATE_EVENTS[input.gate];
    if (event) {
      repo.recordEvent({
        projectId: input.projectId,
        type: event as never,
        actor: input.actor,
        payload: { gate: input.gate },
      });
    }

    // Approving the canon locks its assets; a later change needs a new version
    // and a fresh approval (VISUAL_CANON.md).
    if (input.gate === 'visual_canon') {
      for (const asset of repo.listVisualAssets(input.projectId)) {
        if (asset.status !== 'retired') repo.setAssetStatus(asset.id, 'locked');
      }
    }
  }

  advanceProject(input.projectId);
}

/* ------------------------- stage side effects ----------------------- */

function runStageHooks(project: repo.ProjectRow, stage: StageDefinition): void {
  switch (stage.id) {
    case 'discover':
      repo.recordEvent({ projectId: project.id, type: 'BRIEF_CREATED', actor: 'system' });
      syncProjectFromBrief(project.id);
      break;
    case 'research':
      repo.recordEvent({ projectId: project.id, type: 'RESEARCH_COMPLETE', actor: 'system' });
      break;
    case 'map':
      repo.recordEvent({ projectId: project.id, type: 'MAP_COMPLETE', actor: 'system' });
      break;
    case 'visual_canon':
      repo.recordEvent({ projectId: project.id, type: 'VISUAL_CANON_CREATED', actor: 'system' });
      break;
    case 'author':
      repo.recordEvent({ projectId: project.id, type: 'CHAPTER_DRAFTED', actor: 'system' });
      break;
    case 'criticise':
      repo.recordEvent({ projectId: project.id, type: 'CRITIQUE_COMPLETE', actor: 'system' });
      break;
    case 'edit':
      repo.recordEvent({ projectId: project.id, type: 'REVISION_COMPLETE', actor: 'system' });
      break;
    case 'illustrate':
      repo.recordEvent({ projectId: project.id, type: 'ILLUSTRATION_GENERATED', actor: 'system' });
      break;
    // Rendering belongs to the Proof job, which awaits it and QAs the result.

    case 'proof':
      repo.recordEvent({ projectId: project.id, type: 'PDF_PROOFED', actor: 'system' });
      markReadyForPublish(project.id);
      break;
    case 'deliver':
      finalisePublication(project.id);
      break;
    default:
      break;
  }
}

/** Mirrors brief fields onto the project row so listings stay meaningful. */
function syncProjectFromBrief(projectId: string): void {
  const brief = repo.latestArtifact<{ title?: string; genre?: string; audience?: string }>(
    projectId,
    'brief',
  );
  if (!brief) return;
  repo.updateProject(projectId, {
    ...(brief.data.title ? { title: brief.data.title } : {}),
    ...(brief.data.genre ? { genre: brief.data.genre } : {}),
    ...(brief.data.audience ? { audience: brief.data.audience } : {}),
  });
}

/* -------------------------- revision loop --------------------------- */

/**
 * Called once the rewrite for a round is done. Returns true when the project
 * looped back for another critique pass over the revised text.
 */
function applyRevisionDecision(project: repo.ProjectRow): boolean {
  // Only chapters rewritten this round whose diagnosis carried an issue at the
  // re-read severity go back to the critics. A rewrite that answered nothing
  // above that bar is trusted: verifying it costs a full critique round, and on
  // the measured runs those rounds found nothing the critics had asked for.
  const cycle = project.revisionCycle;
  const reread = chaptersToReread(project, cycle);
  if (reread.length === 0) return false;
  // The re-read bar can sit below critical, but only critical issues block
  // publication, so only they can turn an exhausted budget into an escalation.
  const openIssues = reread.length;
  const openCriticalIssues = openCriticalTasks(project, cycle);

  const decision = revisionDecision({
    cycle,
    maxCycles: env().MAX_REVISION_CYCLES,
    openCriticalIssues,
    openIssues,
  });

  if (decision === 'pass') return false;

  if (decision === 'escalate') {
    // Budget exhausted with critical issues open. Publishing stays blocked by
    // the acceptance check until a human intervenes.
    repo.recordEvent({
      projectId: project.id,
      type: 'REVISION_REQUIRED',
      actor: 'system',
      payload: { openCriticalIssues, openIssues, exhausted: true },
    });
    setStatus(project.id, 'review');
    return false;
  }

  repo.recordEvent({
    projectId: project.id,
    type: 'REVISION_REQUIRED',
    actor: 'system',
    payload: { openCriticalIssues, openIssues, cycle: cycle + 1 },
  });

  // Reopen the loop stages at the next round so critics re-read revised text.
  repo.updateProject(project.id, {
    revisionCycle: cycle + 1,
    completedStages: project.completedStages.filter((s) => !LOOP_STAGES.has(s)),
  });
  return true;
}

/* --------------------------- illustration --------------------------- */

/** Re-renders scenes Visual QA rejected, up to the attempt cap. */
/**
 * Keeps the illustrate stage open while renders are still being judged or
 * redone. Returns true when the stage must stay open.
 *
 * A render is judged only once it exists: the previous verdict was about the
 * previous render, so QA for a regeneration is enqueued after the generator
 * completes, never alongside it (enqueued together, the worker ran both at
 * once and every regeneration on the measured run was graded against the old
 * image). Only a canon violation earns another render; a verdict that would
 * merely prefer a change does not, and neither does one that says another
 * render will not help.
 */
function enqueueRegenerations(project: repo.ProjectRow): boolean {
  const generatorJobs = repo.jobsForAgent(project.id, 'illustrate', 'image-generator');
  const qaJobs = repo.jobsForAgent(project.id, 'illustrate', 'visual-qa');
  const inFlight = (j: repo.JobRow) => j.status === 'queued' || j.status === 'running';
  if (generatorJobs.some(inFlight) || qaJobs.some(inFlight)) return true;

  // A regeneration that failed is left for a person to retry, and the stage
  // stays open so the retried render is judged rather than orphaned.
  const stuck = (j: repo.JobRow) => j.round > 0 && (j.status === 'failed' || j.status === 'blocked');
  if (generatorJobs.some(stuck) || qaJobs.some(stuck)) {
    setStatus(project.id, 'review');
    return true;
  }

  const attempts = new Map<string, number>();
  for (const job of generatorJobs) {
    if (!job.scopeKey) continue;
    attempts.set(job.scopeKey, (attempts.get(job.scopeKey) ?? 0) + 1);
  }
  const judged = new Set(qaJobs.map((j) => `${j.scopeKey}@${j.round}`));

  const verdicts = new Map(
    repo
      .latestArtifactsOfKind<{
        sceneKey: string;
        passed: boolean;
        recommendation: string;
        artworkRevision?: number;
      }>(project.id, 'visual_qa_result')
      // Keyed by artifact scope: identity is the job's scene, not a field the model echoed.
      .map((r) => [r.scopeKey ?? r.data.sceneKey, r.data] as const),
  );

  let enqueued = false;
  const unresolved: string[] = [];
  for (const artwork of repo.latestArtifactsOfKind<{ sceneKey: string; revision: number }>(project.id, 'artwork')) {
    const sceneKey = artwork.scopeKey ?? artwork.data.sceneKey;
    const revision = artwork.data.revision;
    const verdict = verdicts.get(sceneKey);
    // Revision N was rendered by generator round N-1 and is judged at that round.
    const round = Math.max(0, revision - 1);

    const unjudged = !verdict || (verdict.artworkRevision !== undefined && verdict.artworkRevision < revision);
    if (unjudged) {
      if (judged.has(`${sceneKey}@${round}`)) continue; // judged and failed to verdict: left for a person
      repo.enqueueJob({ projectId: project.id, stage: 'illustrate', agent: 'visual-qa', scopeKey: sceneKey, round });
      enqueued = true;
      continue;
    }

    // Only a render that failed earns another. `passed` is derived at commit
    // from the checks, so this is the same gate publication uses.
    if (verdict.passed) continue;
    const made = attempts.get(sceneKey) ?? 0;
    if (verdict.recommendation === 'escalate' || made >= env().MAX_IMAGE_ATTEMPTS) {
      unresolved.push(sceneKey);
      continue;
    }
    repo.enqueueJob({ projectId: project.id, stage: 'illustrate', agent: 'image-generator', scopeKey: sceneKey, round: made });
    enqueued = true;
  }

  // A render still failing with its attempts spent is left for a person, and
  // said so: publication stays blocked on it until it passes.
  if (!enqueued && unresolved.length > 0) {
    repo.recordEvent({
      projectId: project.id,
      type: 'ILLUSTRATION_UNRESOLVED',
      actor: 'system',
      payload: { scenes: unresolved },
    });
  }
  return enqueued;
}

/* ------------------------------- PDF -------------------------------- */

/** Re-renders on demand, e.g. to produce the final export of an edition. */
export async function renderProjectPdf(
  projectId: string,
  prefix: 'renders' | 'exports' = 'renders',
  filename = 'edition-draft.pdf',
): Promise<string | null> {
  const pageModel = repo.latestArtifact<PageModel>(projectId, 'page_model');
  if (!pageModel) return null;

  const result = await renderPdf(pageModel.data);
  const key = storageKey(projectId, prefix, filename);
  await putBlob(key, result.pdf);

  repo.recordEvent({
    projectId,
    type: 'PDF_RENDERED',
    actor: 'system',
    payload: {
      pageCount: result.pageCount, engine: result.engine,
      missingImages: result.missingImages, storageKey: key,
    },
  });
  return key;
}

/* ---------------------------- publication --------------------------- */

function markReadyForPublish(projectId: string): void {
  const project = repo.getProject(projectId);
  if (!project || project.publicationState !== 'DRAFT') return;
  repo.updateProject(projectId, {
    publicationState: 'READY_FOR_PUBLISH',
    status: 'ready_for_publish',
  });
}

function finalisePublication(projectId: string): void {
  const project = repo.getProject(projectId);
  if (!project) return;

  const edition = repo.latestArtifact<{ title: string; blurb: string }>(projectId, 'edition');
  const frozen = [
    'brief', 'design_spec', 'architecture', 'outline',
    'page_model', 'clean_manuscript', 'artwork',
  ]
    .flatMap((kind) => repo.latestArtifactsOfKind(projectId, kind as never))
    .map((a) => a.id);

  const pdfKey = storageKey(projectId, 'exports', 'edition.pdf');

  const row = repo.createEdition({
    projectId,
    title: edition?.data.title ?? project.title,
    blurb: edition?.data.blurb ?? '',
    frozenArtifacts: frozen,
    pdfStorageKey: pdfKey,
  });

  repo.markEditionPublished(row.id);
  repo.updateProject(projectId, {
    editionId: row.id,
    publicationState: 'PUBLISHED',
    status: 'published',
  });
  repo.recordEvent({
    projectId,
    type: 'PUBLICATION_COMPLETE',
    actor: 'system',
    payload: { editionId: row.id },
  });
}

/* ------------------------------ worker ------------------------------ */

let running = false;
let timer: NodeJS.Timeout | null = null;
const inFlight = new Set<string>();

/**
 * In-process worker loop. ARCHITECTURE.md specifies Redis/BullMQ; the queue is
 * held in SQLite here so the MVP runs without a broker. `claimNextJob` is a
 * conditional update, so this loop is safe to run in more than one process.
 */
export function startWorker(): void {
  if (running) return;
  running = true;

  const tick = async (): Promise<void> => {
    try {
      const capacity = env().AGENT_CONCURRENCY - inFlight.size;
      for (let i = 0; i < capacity; i++) {
        const job = repo.claimNextJob();
        if (!job) break;

        inFlight.add(job.id);
        void runJob(job)
          .catch(() => {
            /* runJob records its own failures */
          })
          .finally(() => {
            inFlight.delete(job.id);
            try {
              advanceProject(job.projectId);
            } catch {
              /* scheduling errors must not kill the loop */
            }
          });
      }
    } finally {
      if (running) timer = setTimeout(() => void tick(), 500);
    }
  };

  void tick();
}

export function stopWorker(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function workerStatus(): { running: boolean; inFlight: number } {
  return { running, inFlight: inFlight.size };
}
