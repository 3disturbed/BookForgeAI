import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFakeOpenAI, state as fakeState, type FakeOpenAI } from './fake-openai.js';
import { countOccurrences } from '../domain/terms.js';

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
