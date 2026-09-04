import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFakeOpenAI, state as fakeState, type FakeOpenAI } from './fake-openai.js';
import { countOccurrences, deriveCorrections } from '../domain/terms.js';

/**
 * Drives the whole pipeline against a stubbed model API: 22 agents, the
 * approval gates, the revision loop, PDF rendering and the $100 publication
 * flow, with no network access and no API key.
 */
let fake: FakeOpenAI;
let dataDir: string;

// Modules cache configuration on first use, so env must be set before import.
let repo: typeof import('../store/repo.js');
let orchestrator: typeof import('../queue/orchestrator.js');
let runner: typeof import('../agents/runner.js');
let blobs: typeof import('../storage/blobs.js');
let paths: typeof import('../domain/storage-paths.js');

before(async () => {
  fake = await startFakeOpenAI();
  dataDir = mkdtempSync(join(tmpdir(), 'bookforge-test-'));

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: fake.url,
    OPENAI_TEXT_MODEL: 'test-text',
    OPENAI_REASONING_MODEL: 'test-reasoning',
    OPENAI_IMAGE_MODEL: 'test-image',
    ENABLE_ILLUSTRATIONS: 'true',
    MAX_REVISION_CYCLES: '3',
    REVISION_REREAD_SEVERITY: 'critical',
    APP_BASE_URL: 'http://localhost:3000',
  });

  repo = await import('../store/repo.js');
  orchestrator = await import('../queue/orchestrator.js');
  runner = await import('../agents/runner.js');
  blobs = await import('../storage/blobs.js');
  paths = await import('../domain/storage-paths.js');
});

after(async () => {
  await fake?.close();
  const { closeDatabase } = await import('../store/db.js');
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Runs queued jobs and clears approval gates until the pipeline settles. */
async function drain(projectId: string, limit = 500): Promise<void> {
  for (let i = 0; i < limit; i++) {
    orchestrator.advanceProject(projectId);

    const job = repo.claimNextJob(projectId);
    if (job) {
      await runner.runJob(job);
      continue;
    }
    if (!approvePendingGates(projectId)) return;
  }
  throw new Error('pipeline did not settle');
}

/** Stands in for the human at each approval gate (SDD.md §6). */
function approvePendingGates(projectId: string): boolean {
  const project = repo.getProject(projectId)!;
  const approvals = repo.listApprovals(projectId);

  let approved = false;
  for (const stage of project.completedStages) {
    const gate = pipelineGate(stage);
    // Payment is not a human click; it is unlocked by a confirmed payment.
    if (!gate || gate === 'publication_payment') continue;
    if (approvals[gate] === true) continue;
    orchestrator.applyApproval({ projectId, gate, approved: true, actor: 'test' });
    approved = true;
  }
  return approved;
}

function pipelineGate(stageId: string) {
  const table: Record<string, string> = {
    discover: 'brief', architect: 'architecture', visual_canon: 'visual_canon',
    outline: 'outline', edit: 'manuscript', illustrate: 'key_illustrations',
    proof: 'final_pdf', publish: 'publication_payment',
  };
  return table[stageId] as never;
}

test('a project runs the full pipeline and publishes', async () => {
  const user = repo.upsertUser('e2e@example.com');
  const project = repo.createProject({
    userId: user.id,
    title: 'The Lantern Keeper',
    idea: 'A lighthouse keeper discovers the light is answering something at sea.',
    genre: 'Literary fantasy',
    audience: 'Adult',
  });

  await drain(project.id);

  const afterForge = repo.getProject(project.id)!;

  // Every stage up to publication ran.
  assert.ok(afterForge.completedStages.includes('author'), 'chapters were authored');
  assert.ok(afterForge.completedStages.includes('illustrate'), 'illustrations were produced');
  assert.ok(afterForge.completedStages.includes('layout'), 'layout ran');
  assert.ok(afterForge.completedStages.includes('proof'), 'proof ran');

  // Artifacts landed, schema-validated, one per chapter.
  const chapters = repo.latestArtifactsOfKind(project.id, 'clean_manuscript');
  assert.equal(chapters.length, 2, 'both chapters reached clean manuscript');

  const assets = repo.listVisualAssets(project.id);
  assert.equal(assets.length, 2, 'visual canon registered its assets');
  assert.ok(assets.every((a) => a.status === 'locked'), 'approving the canon locks assets');
  assert.ok(
    assets.every((a) => a.referenceImageKeys.length > 0),
    'each canon asset got reference art',
  );

  const artwork = repo.latestArtifactsOfKind(project.id, 'artwork');
  assert.ok(artwork.length >= 2, 'each chapter produced an illustration');

  // The PDF was rendered from the page model before proofing.
  const draftKey = paths.storageKey(project.id, 'renders', 'edition-draft.pdf');
  assert.ok(await blobs.blobExists(draftKey), 'a PDF was rendered');
  const pdf = await blobs.getBlob(draftKey);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'output is a real PDF');

  // Publication is blocked until the $100 payment is confirmed.
  assert.equal(repo.getProject(project.id)!.publicationState, 'READY_FOR_PUBLISH');

  const { createCheckoutSession, confirmPayment } = await import('../billing/checkout.js');
  const session = await createCheckoutSession(project.id);
  assert.equal(session.amountCents, 10000, 'the publishing charge is $100');
  assert.equal(repo.getProject(project.id)!.publicationState, 'PAYMENT_REQUIRED');

  confirmPayment(session.sessionId);
  assert.equal(repo.getProject(project.id)!.publicationState, 'PAID');

  orchestrator.applyApproval({
    projectId: project.id, gate: 'publication_payment', approved: true, actor: 'test',
  });
  repo.updateProject(project.id, { publicationState: 'PUBLISHING' });
  await drain(project.id);

  const published = repo.getProject(project.id)!;
  assert.equal(published.publicationState, 'PUBLISHED');
  assert.ok(published.editionId, 'an edition was created');

  const edition = repo.getEdition(published.editionId!)!;
  assert.ok(edition.publishedAt, 'the edition is marked published');
  assert.ok(edition.frozenArtifacts.length > 0, 'the edition freezes its artifact versions');

  // Usage was metered for margin analysis (BILLING.md).
  const usage = repo.totalUsage(project.id);
  assert.ok(usage.textOutputTokens > 0, 'text usage was recorded');
  assert.ok(usage.imageGenerations > 0, 'image usage was recorded');
  assert.ok(usage.imageOutputTokens > 0, 'image tokens were read from the image response');
  assert.ok(usage.cachedInputTokens > 0, 'cached input tokens reach the ledger');
  const imageLine = repo.usageBreakdown(project.id).find((l) => l.agent === 'image-generator');
  assert.ok(imageLine && imageLine.capability === 'image', 'image spend sits on the image tier');
  const designerImage = repo.usageBreakdown(project.id)
    .find((l) => l.agent === 'asset-designer' && l.capability === 'image');
  assert.ok(designerImage, "asset-designer's reference render is ledgered on its own tier line");
  // The line aggregates every asset-designer job, so "one sheet per job" is
  // delivered images equalling ledger rows, not equalling one.
  assert.equal(
    designerImage.imageGenerations, designerImage.calls,
    'one reference sheet delivered per asset job',
  );
  const qaLine = repo.usageBreakdown(project.id).find((l) => l.agent === 'visual-qa');
  assert.ok(qaLine, 'visual-qa has a ledger line');
  assert.equal(
    qaLine.imageInputImages, 0,
    'the inspected render is inside its prompt tokens, not counted again as an image input',
  );
  assert.ok(imageLine.imageGenerations >= 2 && imageLine.imageCalls >= imageLine.imageGenerations,
    'delivered images and API calls are tracked separately');

  // Every job recorded its model and prompt version (SDD.md §9).
  const jobs = repo.listJobs(project.id, 500);
  const completed = jobs.filter((j) => j.status === 'completed');
  assert.ok(completed.length >= 20, `expected many completed jobs, saw ${completed.length}`);
  assert.equal(jobs.filter((j) => j.status === 'failed').length, 0, 'no job failed');
  assert.ok(completed.every((j) => j.model && j.promptVersion), 'jobs record model and prompt');

  // Critics ran as five independent personas per chapter.
  const critiques = repo.latestArtifactsOfKind(project.id, 'critique');
  assert.equal(critiques.length, 10, 'five critic personas across two chapters');
});

test('the editorial loop rewrites, re-reads, and terminates', async () => {
  // Two chapters diagnosed as needing a rewrite: the loop must rewrite them,
  // send the revised text back to the critics, and then settle.
  fakeState.demandRewrites = 2;

  const user = repo.upsertUser('loop@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Loop', idea: 'A book that needs a second pass.',
  });

  await drain(project.id);
  const after = repo.getProject(project.id)!;

  assert.ok(after.revisionCycle >= 1, 'the loop went round at least once');
  assert.ok(
    after.revisionCycle <= 3,
    `the loop terminated within MAX_REVISION_CYCLES, saw ${after.revisionCycle}`,
  );

  // The rewrite actually ran — deciding before the rewrite used to skip it.
  const revised = repo.latestArtifactsOfKind(project.id, 'revised_content');
  assert.ok(revised.length > 0, 'the rewriter produced revised chapters');

  // Critics re-read the revised text, so there are critiques from a later round.
  const jobs = repo.listJobs(project.id, 500);
  const laterRounds = jobs.filter((j) => j.agent === 'critics' && j.round > 0);
  assert.ok(laterRounds.length > 0, 'critics ran again after the rewrite');

  // And the pipeline did not stall: it reached the end.
  assert.ok(after.completedStages.includes('proof'), 'the pipeline ran to completion');
  assert.equal(jobs.filter((j) => j.status === 'queued' || j.status === 'running').length, 0);
});

test('a loop that never satisfies the critics escalates instead of spinning', async () => {
  // Diagnosis demands a rewrite every single time. The loop must exhaust its
  // budget, record the escalation, and hand the book on rather than spinning.
  fakeState.demandRewrites = Number.MAX_SAFE_INTEGER;

  const user = repo.upsertUser('escalate@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Escalate', idea: 'A book the critics never accept.',
  });

  try {
    await drain(project.id);
  } finally {
    fakeState.demandRewrites = 0;
  }

  const after = repo.getProject(project.id)!;
  const maxCycles = Number(process.env.MAX_REVISION_CYCLES ?? 3);

  assert.equal(after.revisionCycle, maxCycles, 'the loop stopped at its budget');

  const escalated = repo
    .listEvents(project.id, 200)
    .filter((e) => e.type === 'REVISION_REQUIRED' && e.payload.exhausted === true);
  assert.equal(escalated.length, 1, 'the exhaustion was recorded once for a human');

  // It moved on rather than deadlocking.
  assert.ok(after.completedStages.includes('edit'), 'the book progressed past the loop');
  const jobs = repo.listJobs(project.id, 800);
  assert.equal(jobs.filter((j) => j.status === 'queued' || j.status === 'running').length, 0);

  // But publication stays blocked while critical issues are open (SDD.md §11).
  const openCritical = repo
    .latestArtifactsOfKind<{ verdict: string; tasks: { severity: string }[] }>(
      project.id, 'revision_tasks',
    )
    .filter((a) => a.data.verdict === 'revise')
    .reduce((n, a) => n + (a.data.tasks ?? []).filter((t) => t.severity === 'critical').length, 0);
  assert.ok(openCritical > 0, 'critical issues remain open, so acceptance must block');
});

test('a rewrite driven only by major tasks is not sent back to the critics', async () => {
  // One chapter has a major note: it is rewritten, but nothing blocks
  // publication, so the loop exits without a further critique round.
  fakeState.demandMajorRewrites = 1;

  const user = repo.upsertUser('major@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Major', idea: 'A book with one major note.',
  });

  try {
    await drain(project.id);
  } finally {
    fakeState.demandMajorRewrites = 0;
  }

  const after = repo.getProject(project.id)!;
  const jobs = repo.listJobs(project.id, 500);

  assert.equal(jobs.filter((j) => j.agent === 'rewriter').length, 1, 'the major task was still rewritten');
  assert.equal(
    jobs.filter((j) => j.agent === 'critics' && j.round > 0).length, 0,
    'a major-only rewrite is not re-read',
  );
  assert.equal(jobs.filter((j) => j.agent === 'diagnosis' && j.round > 0).length, 0);
  assert.ok(after.completedStages.includes('proof'), 'the pipeline ran to completion');
  assert.equal(jobs.filter((j) => j.status === 'queued' || j.status === 'running').length, 0);
});

test('only the chapter whose diagnosis found a critical issue is re-critiqued', async () => {
  // Two chapters, one critical finding: the re-read covers that chapter alone.
  fakeState.demandRewrites = 1;

  const user = repo.upsertUser('scoped@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Scoped', idea: 'A book with one critical note.',
  });

  try {
    await drain(project.id);
  } finally {
    fakeState.demandRewrites = 0;
  }

  const chapterOf = (scopeKey: string | null | undefined) => (scopeKey ?? '').split('#')[0];
  const jobs = repo.listJobs(project.id, 500);
  const rewrites = jobs.filter((j) => j.agent === 'rewriter');
  assert.equal(rewrites.length, 1, 'exactly one chapter was rewritten');
  const flagged = chapterOf(rewrites[0]!.scopeKey);

  assert.equal(jobs.filter((j) => j.agent === 'critics' && j.round === 0).length, 10);
  const reread = jobs.filter((j) => j.agent === 'critics' && j.round > 0);
  assert.equal(reread.length, 5, 'five personas re-read exactly one chapter');
  assert.ok(reread.every((j) => chapterOf(j.scopeKey) === flagged), 'the re-read is the rewritten chapter');

  const rediagnosed = jobs.filter((j) => j.agent === 'diagnosis' && j.round > 0);
  assert.equal(rediagnosed.length, 1);
  assert.equal(chapterOf(rediagnosed[0]!.scopeKey), flagged);

  const after = repo.getProject(project.id)!;
  assert.ok(after.completedStages.includes('proof'), 'the pipeline ran to completion');
  assert.equal(jobs.filter((j) => j.status === 'queued' || j.status === 'running').length, 0);
});

test('a chapter rewritten for a major task is not rewritten again while another chapter loops', async () => {
  // Chapter one carries a critical task, chapter two a major one. Both are
  // rewritten once; only chapter one is re-read. Chapter two's old verdict must
  // not drive a second rewrite in the round it sat out.
  fakeState.demandRewrites = 1;
  fakeState.demandMajorRewrites = 1;

  const user = repo.upsertUser('stale@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Stale', idea: 'A book with one critical and one major note.',
  });

  try {
    await drain(project.id);
  } finally {
    fakeState.demandRewrites = 0;
    fakeState.demandMajorRewrites = 0;
  }

  const jobs = repo.listJobs(project.id, 500);
  const rewrites = jobs.filter((j) => j.agent === 'rewriter');
  assert.equal(rewrites.length, 2, 'each flagged chapter was rewritten exactly once');
  assert.ok(rewrites.every((j) => j.round === 0), 'no rewrite ran in the re-read round');
  assert.equal(new Set(rewrites.map((j) => j.scopeKey)).size, 2, 'the two rewrites are two chapters');

  const reread = jobs.filter((j) => j.agent === 'critics' && j.round > 0);
  assert.equal(reread.length, 5, 'one chapter was re-read');
  assert.equal(jobs.filter((j) => j.agent === 'diagnosis' && j.round > 0).length, 1);

  const after = repo.getProject(project.id)!;
  assert.ok(after.completedStages.includes('proof'), 'the pipeline ran to completion');
  assert.equal(jobs.filter((j) => j.status === 'queued' || j.status === 'running').length, 0);
});

test('a diagnosis that outranks its critiques is clamped and does not reopen the loop', async () => {
  // The critics raise nothing; diagnosis claims a critical task anyway. The
  // stored plan carries the critics' ceiling and nothing is rewritten.
  fakeState.inflateDiagnosis = 1;

  const user = repo.upsertUser('inflate@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Inflate', idea: 'A book whose diagnosis exaggerates.',
  });

  try {
    await drain(project.id);
  } finally {
    fakeState.inflateDiagnosis = 0;
  }

  const plans = repo.latestArtifactsOfKind<{ verdict: string; tasks: { severity: string }[] }>(
    project.id, 'revision_tasks',
  );
  assert.equal(plans.length, 2);
  const inflated = plans.filter((p) => p.data.tasks.length > 0);
  assert.equal(inflated.length, 1, 'one diagnosis carried the invented task');
  assert.ok(
    inflated[0]!.data.tasks.every((t) => t.severity === 'minor'),
    'the task was capped at what the critics raised',
  );
  assert.ok(plans.every((p) => p.data.verdict === 'pass'), 'a plan with nothing above minor is a pass');

  const jobs = repo.listJobs(project.id, 500);
  assert.equal(jobs.filter((j) => j.agent === 'rewriter').length, 0, 'nothing was rewritten');
  assert.equal(jobs.filter((j) => j.round > 0).length, 0, 'the loop did not reopen');
  const after = repo.getProject(project.id)!;
  assert.equal(after.revisionCycle, 0);
  assert.ok(after.completedStages.includes('proof'), 'the pipeline ran to completion');
});

test('a diagnosis raised above major-only critiques is rewritten as major and not re-read', async () => {
  // Every critic says major; one diagnosis says critical. The stored task is
  // major, so the chapter is rewritten once and trusted.
  fakeState.inflateDiagnosis = 1;
  fakeState.demandMajorRewrites = 1;

  const user = repo.upsertUser('capped@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Capped', idea: 'A book whose diagnosis overstates a major note.',
  });

  try {
    await drain(project.id);
  } finally {
    fakeState.inflateDiagnosis = 0;
    fakeState.demandMajorRewrites = 0;
  }

  const plans = repo.latestArtifactsOfKind<{ verdict: string; tasks: { severity: string }[] }>(
    project.id, 'revision_tasks',
  );
  assert.equal(plans.length, 2);
  assert.ok(
    plans.every((p) => p.data.verdict === 'revise' && p.data.tasks.every((t) => t.severity === 'major')),
    'both plans carry the critics\' ceiling',
  );

  const jobs = repo.listJobs(project.id, 500);
  const rewrites = jobs.filter((j) => j.agent === 'rewriter');
  assert.equal(rewrites.length, 2, 'both chapters were rewritten');
  assert.ok(rewrites.every((j) => j.round === 0));
  assert.equal(jobs.filter((j) => j.round > 0).length, 0, 'a major-only rewrite is not re-read');
  assert.ok(repo.getProject(project.id)!.completedStages.includes('proof'));
});

test('REVISION_REREAD_SEVERITY=major sends a major-only rewrite back to the critics', async () => {
  const { resetEnvCache } = await import('../domain/env.js');
  process.env.REVISION_REREAD_SEVERITY = 'major';
  resetEnvCache();
  fakeState.demandMajorRewrites = 1;

  const user = repo.upsertUser('reread-major@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Reread', idea: 'A book that re-reads major rewrites.',
  });

  try {
    await drain(project.id);
  } finally {
    fakeState.demandMajorRewrites = 0;
    process.env.REVISION_REREAD_SEVERITY = 'critical';
    resetEnvCache();
  }

  const jobs = repo.listJobs(project.id, 500);
  assert.equal(jobs.filter((j) => j.agent === 'rewriter').length, 1, 'one chapter was rewritten');
  assert.equal(jobs.filter((j) => j.agent === 'critics' && j.round > 0).length, 5, 'that chapter was re-read');
  assert.equal(jobs.filter((j) => j.agent === 'diagnosis' && j.round > 0).length, 1);

  const after = repo.getProject(project.id)!;
  assert.equal(after.revisionCycle, 1);
  const exhausted = repo
    .listEvents(project.id, 200)
    .filter((e) => e.type === 'REVISION_REQUIRED' && e.payload.exhausted === true);
  assert.equal(exhausted.length, 0, 'nothing critical was open, so nothing escalated');
  assert.ok(after.completedStages.includes('proof'), 'the pipeline ran to completion');
});

test('a budget spent on major issues alone ends the loop without escalating', async () => {
  // With the re-read bar at major and critics who never stop finding majors,
  // the loop uses its budget and then moves on: nothing blocks publication.
  const { resetEnvCache } = await import('../domain/env.js');
  process.env.REVISION_REREAD_SEVERITY = 'major';
  resetEnvCache();
  fakeState.demandMajorRewrites = Number.MAX_SAFE_INTEGER;

  const user = repo.upsertUser('majors-forever@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Majors', idea: 'A book the critics always want tightened.',
  });

  try {
    await drain(project.id);
  } finally {
    fakeState.demandMajorRewrites = 0;
    process.env.REVISION_REREAD_SEVERITY = 'critical';
    resetEnvCache();
  }

  const after = repo.getProject(project.id)!;
  const maxCycles = Number(process.env.MAX_REVISION_CYCLES ?? 3);
  assert.equal(after.revisionCycle, maxCycles, 'the loop used its whole budget');

  const events = repo.listEvents(project.id, 300).filter((e) => e.type === 'REVISION_REQUIRED');
  assert.equal(events.filter((e) => e.payload.exhausted === true).length, 0, 'majors alone do not escalate');
  assert.equal(events.length, maxCycles, 'one reopen per cycle');

  assert.ok(after.completedStages.includes('proof'), 'the book moved on');
  const jobs = repo.listJobs(project.id, 800);
  assert.equal(jobs.filter((j) => j.status === 'queued' || j.status === 'running').length, 0);
});

test('payment confirmation is idempotent', async () => {
  const user = repo.upsertUser('idem@example.com');
  const project = repo.createProject({ userId: user.id, title: 'T', idea: 'An idea for a book.' });
  repo.updateProject(project.id, { publicationState: 'READY_FOR_PUBLISH' });

  const { createCheckoutSession, confirmPayment } = await import('../billing/checkout.js');
  const session = await createCheckoutSession(project.id);

  confirmPayment(session.sessionId);
  const first = repo.getProject(project.id)!.publicationState;
  confirmPayment(session.sessionId);
  const second = repo.getProject(project.id)!.publicationState;

  assert.equal(first, 'PAID');
  assert.equal(second, 'PAID', 'replaying the webhook changes nothing');
});

test('signed file links are scoped and expire', async () => {
  const key = paths.storageKey('proj-a', 'renders', 'edition.pdf');
  await blobs.putBlob(key, Buffer.from('%PDF-1.4 test'));

  const signed = blobs.signedUrlFor(key, 'proj-a');
  const url = new URL(signed.url);
  assert.ok(blobs.verifySignedUrl(key, url.searchParams.get('exp')!, url.searchParams.get('sig')!));

  // A signature from another project's key must not verify.
  assert.equal(blobs.verifySignedUrl(key, url.searchParams.get('exp')!, 'deadbeef'), false);
  assert.throws(() => blobs.signedUrlFor(key, 'proj-b'), /Not authorized/);
  assert.throws(() => blobs.signedUrlFor('../../etc/passwd', 'proj-a'), /Not authorized/);
});

test('author decisions are recorded and reach every agent', async () => {
  const user = repo.upsertUser('decisions@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Decisions', idea: 'A book with choices to make.',
  });

  // Run Discover so a brief with open questions exists.
  orchestrator.advanceProject(project.id);
  const discover = repo.claimNextJob(project.id)!;
  await runner.runJob(discover);

  const brief = repo.latestArtifact<{ openQuestions: string[] }>(project.id, 'brief')!;
  assert.ok(brief.data.openQuestions.length > 0, 'Discover raised questions');

  const question = brief.data.openQuestions[0]!;
  repo.writeArtifact({
    projectId: project.id,
    kind: 'decisions',
    data: {
      answers: [
        { question, answer: 'Yes, the sea is sentient.', delegated: false, answeredAt: 'now' },
        { question: 'ignored', answer: '', delegated: true, answeredAt: 'now' },
      ],
    },
    producedByJobId: null,
  });

  // The brief gate holds the pipeline until a human approves, so clear it.
  orchestrator.applyApproval({
    projectId: project.id, gate: 'brief', approved: true, actor: 'test',
  });

  // The next agent must receive the answered decision, and not the delegated one.
  orchestrator.advanceProject(project.id);
  const research = repo.claimNextJob(project.id);
  assert.ok(research, 'the brief gate released the next stage');
  await runner.runJob(research);

  const seen = fake.lastUserMessage;
  assert.ok(seen.includes('author_decisions'), 'decisions were attached to the agent call');
  assert.ok(seen.includes('Yes, the sea is sentient.'), 'the answer was passed through');
  assert.ok(!seen.includes('"question": "ignored"'), 'delegated questions are not passed');
});

test('an answer to a question the brief never asked is rejected', async () => {
  const user = repo.upsertUser('unknown-q@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Unknown', idea: 'A book with a short question list.',
  });

  orchestrator.advanceProject(project.id);
  await runner.runJob(repo.claimNextJob(project.id)!);

  const { validateAnswers } = await import('../http/decisions.js');
  const asked = repo.latestArtifact<{ openQuestions: string[] }>(project.id, 'brief')!
    .data.openQuestions;

  assert.doesNotThrow(() => validateAnswers(asked, [{ question: asked[0]! }]));
  assert.throws(
    () => validateAnswers(asked, [{ question: 'a question from a different book' }]),
    /No such open question/,
  );
});

test('a stage failed by a dropped connection can be retried back into motion', async () => {
  const user = repo.upsertUser('retry@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Retry', idea: 'A book interrupted by a network fault.',
  });

  orchestrator.advanceProject(project.id);
  await runner.runJob(repo.claimNextJob(project.id)!);
  orchestrator.applyApproval({
    projectId: project.id, gate: 'brief', approved: true, actor: 'test',
  });
  orchestrator.advanceProject(project.id);

  // Exhaust the budget the way a sustained outage would.
  const job = repo.claimNextJob(project.id)!;
  for (let i = 0; i <= Number(process.env.AGENT_MAX_RETRIES ?? 4); i++) {
    repo.failJob(job.id, 'fetch failed: ECONNRESET', i < Number(process.env.AGENT_MAX_RETRIES ?? 4));
  }
  repo.failJob(job.id, 'fetch failed: ECONNRESET', false);
  assert.equal(repo.getJob(job.id)!.status, 'failed');

  // The scheduler will not step past a required agent, so the run is stuck.
  orchestrator.advanceProject(project.id);
  assert.equal(repo.claimNextJob(project.id), null, 'nothing is claimable while it is failed');

  // Retrying restores it with a fresh budget and no backoff wait.
  const requeued = repo.retryFailedJobs(project.id);
  assert.equal(requeued, 1);

  const restored = repo.getJob(job.id)!;
  assert.equal(restored.status, 'queued');
  assert.equal(restored.retryCount, 0, 'the budget is reset');
  assert.equal(restored.retryAfter, null, 'and it is claimable immediately');

  orchestrator.advanceProject(project.id);
  const again = repo.claimNextJob(project.id);
  assert.ok(again, 'the pipeline moves again');
  await runner.runJob(again);
  assert.equal(repo.getJob(again.id)!.status, 'completed');
});

test('an automatic retry waits out a backoff before it can be claimed', async () => {
  const user = repo.upsertUser('backoff@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Backoff', idea: 'A book that hits a rate limit.',
  });
  orchestrator.advanceProject(project.id);

  const job = repo.claimNextJob(project.id)!;
  repo.failJob(job.id, 'rate limited', true);

  const requeued = repo.getJob(job.id)!;
  assert.equal(requeued.status, 'queued');
  assert.ok(requeued.retryAfter, 'a backoff was set');
  assert.ok(
    new Date(requeued.retryAfter!).getTime() > Date.now(),
    'the backoff is in the future',
  );

  // Without the wait, three attempts would burn in about a second.
  assert.equal(repo.claimNextJob(project.id), null, 'it is not claimable yet');
});

test('a spelling decision is repaired across artifacts and locked assets', async () => {
  const user = repo.upsertUser('terms@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Terms', idea: 'A ship with a contested name.',
  });

  // Work written before the answer carries the wrong spelling.
  repo.writeArtifact({
    projectId: project.id, kind: 'knowledge_map', producedByJobId: null,
    data: {
      entities: [{ name: 'Manado', kind: 'vehicle', description: 'The Manado sails.', aliases: ['Manado'] }],
      relationships: [], timeline: [], locations: [],
    },
  });
  const asset = repo.upsertVisualAsset({
    projectId: project.id, name: 'Manado (Longship)', type: 'vehicle',
    importance: 'primary', canonicalDescription: { hull: 'The Manado is clinker-built' },
  });
  // Locking is exactly the state that made this uncorrectable before.
  repo.setAssetStatus(asset.id, 'locked');

  const { artifacts, assets } = repo.applyTermCorrections(project.id, [
    { wrong: 'Manado', right: 'Mapado' },
  ]);

  assert.equal(artifacts, 1, 'the artifact was rewritten');
  assert.equal(assets, 1, 'the locked asset was renamed');

  const map = repo.latestArtifact(project.id, 'knowledge_map')!;
  assert.equal(countOccurrences(map.data, 'Manado'), 0, 'no wrong spelling survives');
  assert.equal(countOccurrences(map.data, 'Mapado'), 3);

  const renamed = repo.listVisualAssets(project.id).find((a) => a.id === asset.id)!;
  assert.equal(renamed.name, 'Mapado (Longship)');
  assert.equal(renamed.version, 2, 'renaming makes a new version, per VISUAL_CANON.md');
  assert.equal(
    countOccurrences(renamed.canonicalDescription, 'Manado'), 0,
    'the canonical description is corrected too',
  );
});

test('renaming an asset carries its per-asset artifacts with it', async () => {
  const user = repo.upsertUser('rename-scope@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Scope', idea: 'A ship whose name changes.',
  });

  const asset = repo.upsertVisualAsset({
    projectId: project.id, name: 'Manado (Longship)', type: 'vehicle',
    importance: 'primary', canonicalDescription: {},
  });
  // Reference packages are keyed by the slug of the asset's name.
  repo.writeArtifact({
    projectId: project.id, kind: 'reference_package', producedByJobId: null,
    scopeKey: 'manado-longship',
    data: { assetName: 'Manado (Longship)', bible: {}, referencePrompts: ['A longship.'], negativePrompts: [] },
  });

  repo.applyTermCorrections(project.id, [{ wrong: 'Manado', right: 'Mapado' }]);

  const renamed = repo.listVisualAssets(project.id).find((a) => a.id === asset.id)!;
  assert.equal(renamed.name, 'Mapado (Longship)');

  // Without moving the scope key the package would be orphaned, and the asset
  // would silently lose its reference art in every later illustration.
  const found = repo.latestArtifact(project.id, 'reference_package', 'mapado-longship');
  assert.ok(found, 'the reference package follows the new name');
  assert.equal(
    repo.latestArtifact(project.id, 'reference_package', 'manado-longship'),
    null,
    'nothing is left under the old key',
  );
});

test('repairing a spelling does not erase the decision that defined it', async () => {
  const user = repo.upsertUser('evidence@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Evidence', idea: 'A ship with a contested name.',
  });

  const question = 'Confirm the ship’s name spelling: Mapado or Manado.';
  repo.writeArtifact({
    projectId: project.id, kind: 'decisions', producedByJobId: null,
    data: { answers: [{ question, answer: 'Mapado', delegated: false, answeredAt: 'now' }] },
  });
  repo.writeArtifact({
    projectId: project.id, kind: 'brief', producedByJobId: null,
    data: { title: 'The Manado', openQuestions: [question] },
  });

  repo.applyTermCorrections(project.id, [{ wrong: 'Manado', right: 'Mapado' }]);

  // Book content is corrected...
  const brief = repo.latestArtifact<{ title: string; openQuestions: string[] }>(project.id, 'brief')!;
  assert.equal(brief.data.title, 'The Mapado');

  // ...but the question and answer still name the rejected spelling, so the
  // correction remains derivable and the repair stays repeatable.
  assert.equal(brief.data.openQuestions[0], question, 'the question is preserved');
  const kept = repo.latestArtifact<{ answers: { question: string }[] }>(project.id, 'decisions')!;
  assert.equal(kept.data.answers[0]!.question, question, 'the decision record is untouched');
  assert.ok(deriveCorrections(kept.data.answers[0]!.question, 'Mapado').length > 0);
});

test('the ledger attributes spend to agent, tier and model, cached and reasoning tokens included', async () => {
  const user = repo.upsertUser('ledger@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Ledger', idea: 'A book whose spend is attributed.',
  });
  orchestrator.advanceProject(project.id);
  await runner.runJob(repo.claimNextJob(project.id)!);

  const line = repo.usageBreakdown(project.id).find((l) => l.agent === 'discover');
  assert.ok(line, 'discover has a ledger line');
  assert.equal(line.capability, 'reasoning');
  assert.equal(line.model, 'test-reasoning');
  assert.equal(line.mode, 'sync');
  assert.equal(line.calls, 1);
  assert.equal(line.failedCalls, 0);
  assert.equal(line.modelCalls, 1);
  assert.equal(line.cachedInputTokens, 120, 'cached tokens are read from the usage details');
  assert.equal(line.reasoningTokens, 40, 'reasoning tokens are read from the usage details');
  assert.ok(line.modelLatencySeconds >= 0);
});

test('a failed attempt still records what it spent', async () => {
  const user = repo.upsertUser('failed-spend@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Failed spend', idea: 'A book whose research fails validation.',
  });
  orchestrator.advanceProject(project.id);
  await runner.runJob(repo.claimNextJob(project.id)!);
  orchestrator.applyApproval({ projectId: project.id, gate: 'brief', approved: true, actor: 'test' });
  orchestrator.advanceProject(project.id);

  fakeState.breakSchemaFor = 'You are the Research agent';
  try {
    const job = repo.claimNextJob(project.id)!;
    await runner.runJob(job);
    assert.notEqual(repo.getJob(job.id)!.status, 'completed', 'the job did not complete');

    const line = repo.usageBreakdown(project.id).find((l) => l.agent === 'research');
    assert.ok(line, 'the failed attempt has a ledger line');
    assert.equal(line.failedCalls, 1, 'and it is counted as failed');
    assert.ok(line.textInputTokens > 0, 'its tokens were recorded rather than lost');
    assert.equal(line.modelCalls, 2, 'the schema-repair retry was counted as a call');
    assert.equal(line.model, 'test-reasoning');
  } finally {
    fakeState.breakSchemaFor = '';
  }
});

test('a reference-image fallback is one delivered image, two calls, and is reported', async () => {
  const { generateImage } = await import('../ai/openai.js');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  fakeState.rejectImageEdits = true;
  try {
    const image = await generateImage({ prompt: 'a lantern', aspectRatio: '1:1', references: [png] });
    assert.equal(image.referenceFallback, true, 'the fallback is reported');
    assert.equal(image.imageCalls, 2, 'the rejected edit and the fresh render are both calls');
    assert.equal(image.referenceCount, 0, 'no reference reached the model');
    assert.equal(image.usage.imageOutputTokens, 1000, 'only the render that delivered was billed');
  } finally {
    fakeState.rejectImageEdits = false;
  }
});

test('spend already billed survives a transport failure on a later attempt', async () => {
  const user = repo.upsertUser('kept-spend@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Kept', idea: 'A book whose research call dies mid-repair.',
  });
  orchestrator.advanceProject(project.id);
  await runner.runJob(repo.claimNextJob(project.id)!);
  orchestrator.applyApproval({ projectId: project.id, gate: 'brief', approved: true, actor: 'test' });
  orchestrator.advanceProject(project.id);

  // Attempt 1 answers with JSON that fails the schema (billed). The repair
  // attempt then hits an outage that outlasts the SDK's own retries.
  fakeState.breakSchemaFor = 'You are the Research agent';
  fakeState.failChatFor = { match: 'You are the Research agent', skip: 1, remaining: 6 };
  try {
    const job = repo.claimNextJob(project.id)!;
    await runner.runJob(job);

    const after = repo.getJob(job.id)!;
    assert.equal(after.status, 'queued', 'a transport failure is retried');
    assert.ok(after.retryAfter, 'behind a backoff');

    const line = repo.usageBreakdown(project.id).find((l) => l.agent === 'research');
    assert.ok(line, 'the failed attempt has a ledger line');
    assert.equal(line.failedCalls, 1);
    assert.equal(line.textInputTokens, 400, "attempt 1's tokens are kept although attempt 2 threw");
    assert.equal(line.modelCalls, 2, 'both attempts are counted, the one that returned nothing included');
  } finally {
    fakeState.breakSchemaFor = '';
    fakeState.failChatFor = { match: '', skip: 0, remaining: 0 };
  }
});

test('a failure before any call books nothing rather than an invented call', async () => {
  const user = repo.upsertUser('no-call@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'No call', idea: 'A book with a missing input.',
  });
  // An author job with no outline behind it fails on MISSING_INPUT before any model call.
  const job = repo.enqueueJob({ projectId: project.id, stage: 'author', agent: 'author', scopeKey: 'ch9' });
  await runner.runJob(repo.claimNextJob(project.id)!);

  assert.equal(repo.getJob(job.id)!.status, 'failed');
  assert.equal(repo.usageBreakdown(project.id).length, 0, 'no ledger line was fabricated');
});

test('an unknown agent name fails the job instead of stranding it', async () => {
  const user = repo.upsertUser('unknown-agent@example.com');
  const project = repo.createProject({
    userId: user.id, title: 'Unknown agent', idea: 'A job for an agent that does not exist.',
  });
  const job = repo.enqueueJob({ projectId: project.id, stage: 'author', agent: 'no-such-agent' });
  await runner.runJob(repo.claimNextJob(project.id)!);

  const after = repo.getJob(job.id)!;
  assert.equal(after.status, 'failed', 'it is failed, not left running');
  assert.match(after.error ?? '', /Unknown agent/);
});
