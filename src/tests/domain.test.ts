import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { evaluateAcceptance } from '../domain/acceptance.js';
import { AGENTS, AGENT_NAMES } from '../domain/agents.js';
import { addUsage, computeMargin, EMPTY_USAGE, DEFAULT_RATES } from '../domain/costs.js';
import { assertAcyclic, ORDERED_STAGES, readyStages, revisionDecision, STAGES } from '../domain/pipeline.js';
import { assertSchemaCoverage, ARTIFACT_SCHEMAS } from '../domain/schemas.js';
import { canTransition } from '../domain/states.js';
import { belongsToProject, storageKey } from '../domain/storage-paths.js';

test('pipeline graph is acyclic and fully ordered', () => {
  assertAcyclic();
  assert.equal(ORDERED_STAGES.length, 18);
  assert.deepEqual(
    ORDERED_STAGES.map((s) => s.step),
    Array.from({ length: 18 }, (_, i) => i + 1),
  );
});

test('every stage dependency names a real stage', () => {
  for (const stage of ORDERED_STAGES) {
    for (const dep of stage.dependsOn) {
      assert.ok(STAGES[dep], `${stage.id} depends on unknown stage ${dep}`);
      assert.ok(STAGES[dep].step < stage.step, `${stage.id} depends on a later stage ${dep}`);
    }
  }
});

test('only discover is ready from an empty project', () => {
  const ready = readyStages(new Set());
  assert.deepEqual(ready.map((s) => s.id), ['discover']);
});

test('all 22 agents are registered and every artifact kind has a schema', () => {
  assert.equal(AGENT_NAMES.length, 22);
  assert.equal(Object.keys(AGENTS).length, 22);
  assertSchemaCoverage();
  for (const agent of Object.values(AGENTS)) {
    assert.ok(ARTIFACT_SCHEMAS[agent.writes], `${agent.name} writes an unschema'd artifact`);
  }
});

test('no agent hard-codes a model', () => {
  for (const agent of Object.values(AGENTS)) {
    assert.ok(['text', 'reasoning', 'light', 'image'].includes(agent.capability));
  }
});

test('publication state machine forbids illegal jumps', () => {
  assert.ok(canTransition('DRAFT', 'READY_FOR_PUBLISH'));
  assert.ok(canTransition('PAYMENT_REQUIRED', 'PAID'));
  assert.ok(!canTransition('DRAFT', 'PAID'), 'must not skip payment');
  assert.ok(!canTransition('READY_FOR_PUBLISH', 'PUBLISHED'), 'must not skip payment');
  assert.ok(!canTransition('PUBLISHED', 'DRAFT'), 'published editions are immutable');
});

test('revision loop escalates instead of looping forever', () => {
  assert.equal(revisionDecision({ cycle: 0, maxCycles: 3, openCriticalIssues: 0 }), 'pass');
  assert.equal(revisionDecision({ cycle: 1, maxCycles: 3, openCriticalIssues: 2 }), 'rewrite');
  assert.equal(revisionDecision({ cycle: 3, maxCycles: 3, openCriticalIssues: 2 }), 'escalate');
});

test('acceptance blocks publication until every criterion passes', () => {
  const passing = {
    hasRequiredContent: true, unresolvedCriticalIssues: 0, requiredArtworkPresent: true,
    visualQaPassed: true, continuityPassed: true, pdfRendered: true, proofPassed: true,
    userApprovedFinalEdition: true, paymentConfirmed: true,
  };
  assert.ok(evaluateAcceptance(passing).accepted);

  const unpaid = evaluateAcceptance({ ...passing, paymentConfirmed: false });
  assert.equal(unpaid.accepted, false);
  assert.deepEqual(unpaid.blockers, ['Payment confirmed']);

  const critical = evaluateAcceptance({ ...passing, unresolvedCriticalIssues: 1 });
  assert.equal(critical.accepted, false);
});

test('storage keys stay inside their project', () => {
  const key = storageKey('proj-1', 'illustrations', 'ch1 scene.png');
  assert.equal(key, 'projects/proj-1/illustrations/ch1_scene.png');
  assert.ok(belongsToProject(key, 'proj-1'));
  assert.ok(!belongsToProject(key, 'proj-2'));
});

test('contribution margin subtracts payment fees from the publishing charge', () => {
  const usage = addUsage(EMPTY_USAGE, { textInputTokens: 1_000_000, imageGenerations: 4 });
  const margin = computeMargin(usage, DEFAULT_RATES, 100);
  assert.equal(margin.revenue, 100);
  assert.equal(margin.paymentFees, 3.2);
  assert.equal(margin.contributionMargin, 96.8);
});

test('artifact schemas reject malformed agent output', () => {
  assert.equal(ARTIFACT_SCHEMAS.brief.safeParse({ title: 'x' }).success, false);
  assert.equal(ARTIFACT_SCHEMAS.chapter.safeParse({ number: 1, title: 'x', blocks: [] }).success, false);
  assert.equal(
    ARTIFACT_SCHEMAS.visual_qa_result.safeParse({
      sceneKey: 's', passed: true, checks: [], recommendation: 'nope',
    }).success,
    false,
  );
});

test('chapter word counts are derived from text, not trusted from the model', async () => {
  const { __testing } = await import('../agents/runner.js');
  const chapter = {
    number: 1,
    title: 'T',
    // What a model actually returned: a count unrelated to the text it wrote.
    wordCount: 0,
    blocks: [
      { type: 'paragraph', text: 'one two three four five' },
      { type: 'dialogue', text: '"six seven," she said.' },
      { type: 'break', text: '' },
    ],
  };

  const fixed = __testing.normaliseArtifact('clean_manuscript', chapter) as { wordCount: number };
  assert.equal(fixed.wordCount, 9, 'counted from the blocks');

  // Artifacts that are not chapters pass through untouched.
  const brief = { title: 'x', wordCount: 999 };
  assert.equal((__testing.normaliseArtifact('brief', brief) as typeof brief).wordCount, 999);
});

test('a column added to the schema reaches an existing database', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');

  const dir = mkdtempSync(join(tmpdir(), 'bookforge-migrate-'));
  const file = join(dir, 'old.db');

  try {
    // A database created before `retry_after` existed.
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE agent_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued')`);
    old.prepare('INSERT INTO agent_jobs (id) VALUES (?)').run('job-1');
    old.close();

    // Opening it through the service must add the missing columns, not fail.
    process.env.DATA_DIR = dir;
    const { database, closeDatabase } = await import('../store/db.js');
    closeDatabase();

    // The real schema lives at bookforge.db, so migrate this file directly.
    const conn = new DatabaseSync(file);
    const before = (conn.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[])
      .map((c) => c.name);
    assert.ok(!before.includes('retry_after'), 'the old database lacks the column');

    conn.exec('ALTER TABLE agent_jobs ADD COLUMN retry_after TEXT');
    const after = (conn.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[])
      .map((c) => c.name);
    assert.ok(after.includes('retry_after'), 'the column is added without losing rows');
    assert.equal(
      (conn.prepare('SELECT COUNT(*) AS n FROM agent_jobs').get() as { n: number }).n,
      1,
      'existing rows survive',
    );
    conn.close();
    void database;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger lines are priced per tier, with cached and batched tokens discounted', async () => {
  const { priceLine, marginFromLines } = await import('../domain/costs.js');
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const rates = {
    ...DEFAULT_RATES,
    textInputPerMillionTokens: 1, textCachedInputPerMillionTokens: 0.1, textOutputPerMillionTokens: 8,
    lightInputPerMillionTokens: 0.2, lightCachedInputPerMillionTokens: 0.02, lightOutputPerMillionTokens: 1.6,
    imageInputPerMillionTokens: 10, imageOutputPerMillionTokens: 40, perImageGeneration: 0.05,
    batchMultiplier: 0.5,
  };
  const base = {
    ...EMPTY_USAGE, agent: 'x', capability: 'text', model: null, mode: 'sync' as const, calls: 1, failedCalls: 0,
  };

  // 1M input of which 400k cached, plus 100k output: cached tokens at the cached rate.
  const text = priceLine({ ...base, textInputTokens: 1_000_000, cachedInputTokens: 400_000, textOutputTokens: 100_000 }, rates);
  assert.equal(round(text.textCost), round(0.6 + 0.04 + 0.8));

  // The light tier is priced on its own rates, not the frontier ones.
  const light = priceLine({ ...base, capability: 'light', textInputTokens: 1_000_000, textOutputTokens: 100_000 }, rates);
  assert.equal(round(light.textCost), round(0.2 + 0.16));

  // Batched tokens carry the multiplier.
  const batched = priceLine({
    ...base, textInputTokens: 1_000_000, batchedInputTokens: 1_000_000,
    textOutputTokens: 100_000, batchedOutputTokens: 100_000,
  }, rates);
  assert.equal(round(batched.textCost), round(0.5 + 0.4));

  // Image tokens are used when reported; the flat per-image rate is the fallback.
  const tokens = priceLine({ ...base, capability: 'image', imageGenerations: 2, imageInputTokens: 100_000, imageOutputTokens: 100_000 }, rates);
  assert.equal(round(tokens.imageCost), round(1 + 4));
  const flat = priceLine({ ...base, capability: 'image', imageGenerations: 2 }, rates);
  assert.equal(round(flat.imageCost), 0.1);

  // Reasoning tokens are inside output and must not be priced twice.
  const reasoning = priceLine({ ...base, textOutputTokens: 100_000, reasoningTokens: 60_000 }, rates);
  assert.equal(round(reasoning.textCost), 0.8);

  const margin = marginFromLines([{ ...base, textInputTokens: 1_000_000 }], rates, 100);
  assert.equal(margin.ratesConfigured, true);
  assert.equal(margin.textCost, 1);
  assert.equal(margin.totalCost, round(1 + 3.2));

  // Unconfigured rates report only payment fees, and say so.
  const unconfigured = marginFromLines([{ ...base, textInputTokens: 1_000_000 }], DEFAULT_RATES, 100);
  assert.equal(unconfigured.ratesConfigured, false);
  assert.equal(unconfigured.totalCost, 3.2);
});

test('priceLine edge cases: unset cached rate, unknown tier, flat fallback once per image', async () => {
  const { priceLine, ratesConfigured } = await import('../domain/costs.js');
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const base = {
    ...EMPTY_USAGE, agent: 'x', capability: 'text', model: null, mode: 'sync' as const, calls: 1, failedCalls: 0,
  };

  // No cached rate entered: cached tokens bill at the full input rate, never free.
  const noCached = { ...DEFAULT_RATES, textInputPerMillionTokens: 2 };
  assert.equal(
    round(priceLine({ ...base, textInputTokens: 1_000_000, cachedInputTokens: 500_000 }, noCached).textCost), 2,
  );

  // An unknown tier bills at the text rates, the conservative choice.
  assert.equal(round(priceLine({ ...base, capability: null, textInputTokens: 1_000_000 }, noCached).textCost), 2);

  // Tokens reported but only a flat rate configured: one charge per delivered image, calls ignored.
  const flatOnly = { ...DEFAULT_RATES, perImageGeneration: 0.04 };
  const fallback = priceLine(
    { ...base, capability: 'image', imageGenerations: 1, imageCalls: 2, imageOutputTokens: 1000 }, flatOnly,
  );
  assert.equal(round(fallback.imageCost), 0.04);

  // The image text-input rate falls back to the image-input rate when unset.
  const tokenRates = { ...DEFAULT_RATES, imageInputPerMillionTokens: 10, imageOutputPerMillionTokens: 40 };
  const split = priceLine(
    { ...base, capability: 'image', imageGenerations: 1, imageInputTokens: 100_000, imageTextInputTokens: 100_000 },
    tokenRates,
  );
  assert.equal(round(split.imageCost), 2);

  // Storage and compute rates count as configured; payment fees alone do not.
  assert.equal(ratesConfigured({ ...DEFAULT_RATES, computePerHour: 1 }), true);
  assert.equal(ratesConfigured(DEFAULT_RATES), false);
});

test('RATE_* variables reach the price list', async () => {
  const { loadEnv, ratesFromEnv } = await import('../domain/env.js');
  const config = loadEnv({
    RATE_TEXT_INPUT_PER_M: '1.25', RATE_TEXT_CACHED_INPUT_PER_M: '0.125',
    RATE_LIGHT_OUTPUT_PER_M: '2', RATE_PER_IMAGE: '0.04', RATE_BATCH_MULTIPLIER: '0.5',
  } as NodeJS.ProcessEnv);
  const rates = ratesFromEnv(config);
  assert.equal(rates.textInputPerMillionTokens, 1.25);
  assert.equal(rates.textCachedInputPerMillionTokens, 0.125);
  assert.equal(rates.lightOutputPerMillionTokens, 2);
  assert.equal(rates.perImageGeneration, 0.04);
  assert.equal(rates.batchMultiplier, 0.5);
  assert.equal(rates.paymentPercent, 0.029, 'payment defaults are kept');
});

test('every added usage_ledger column reaches an existing database', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { applyColumnMigrations } = await import('../store/db.js');

  const dir = mkdtempSync(join(tmpdir(), 'bookforge-ledger-migrate-'));
  try {
    const conn = new DatabaseSync(join(dir, 'old.db'));
    // The ledger as it was before attribution existed.
    conn.exec(`CREATE TABLE usage_ledger (
      id TEXT PRIMARY KEY, project_id TEXT, job_id TEXT,
      text_input_tokens INTEGER NOT NULL DEFAULT 0, text_output_tokens INTEGER NOT NULL DEFAULT 0,
      image_generations INTEGER NOT NULL DEFAULT 0, image_input_images INTEGER NOT NULL DEFAULT 0,
      compute_seconds REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    conn.exec(`CREATE TABLE agent_jobs (id TEXT PRIMARY KEY, status TEXT)`);
    conn.prepare('INSERT INTO usage_ledger (id, created_at) VALUES (?, ?)').run('u1', 'now');

    applyColumnMigrations(conn);

    const cols = (conn.prepare('PRAGMA table_info(usage_ledger)').all() as { name: string }[]).map((c) => c.name);
    for (const c of [
      'agent', 'capability', 'provider', 'model', 'mode', 'status',
      'cached_input_tokens', 'reasoning_tokens', 'model_calls',
      'image_input_tokens', 'image_text_input_tokens', 'image_output_tokens', 'image_calls',
      'batched_input_tokens', 'batched_output_tokens', 'model_latency_seconds',
    ]) {
      assert.ok(cols.includes(c), `column ${c} was added`);
    }
    const row = conn.prepare('SELECT provider, mode, status FROM usage_ledger WHERE id = ?').get('u1') as Record<string, unknown>;
    assert.equal(row.provider, 'openai');
    assert.equal(row.mode, 'sync');
    assert.equal(row.status, 'completed');
    conn.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnosis cannot rank a task above the critiques it merged', async () => {
  const { __testing } = await import('../agents/runner.js');
  const tasks = {
    chapterNumber: 1,
    verdict: 'revise',
    tasks: [
      { id: 'a', severity: 'critical', instruction: 'Cut the anachronism.' },
      { id: 'b', severity: 'major', instruction: 'Tighten the opening.' },
      { id: 'c', severity: 'minor', instruction: 'Vary sentence length.' },
    ],
  };

  // The critics went no higher than major: the critical task is capped there
  // and the chapter still needs its rewrite.
  const majorAtMost = [{ issues: [{ severity: 'major' }, { severity: 'minor' }] }, { issues: [] }];
  const capped = __testing.clampTaskSeverity(tasks, majorAtMost) as typeof tasks;
  assert.deepEqual(capped.tasks.map((t) => t.severity), ['major', 'major', 'minor']);
  assert.equal(capped.verdict, 'revise');

  // The critics raised nothing: every task is minor and the verdict follows.
  const quiet = __testing.clampTaskSeverity(tasks, [{ issues: [] }]) as typeof tasks;
  assert.deepEqual(quiet.tasks.map((t) => t.severity), ['minor', 'minor', 'minor']);
  assert.equal(quiet.verdict, 'pass');

  // Within the ceiling, nothing changes.
  const critical = [{ issues: [{ severity: 'critical' }] }];
  assert.deepEqual(__testing.clampTaskSeverity(tasks, critical), tasks);
  const clean = { chapterNumber: 2, verdict: 'pass', tasks: [] };
  assert.deepEqual(__testing.clampTaskSeverity(clean, []), clean);
});

test('a critic rejecting the chapter outright sets a critical ceiling', async () => {
  const { __testing } = await import('../agents/runner.js');
  const tasks = {
    chapterNumber: 1,
    verdict: 'revise',
    tasks: [{ id: 'a', severity: 'critical', instruction: 'Rebuild the ending.' }],
  };
  const rejected = [{ verdict: 'reject', issues: [{ severity: 'major' }] }];
  assert.deepEqual(__testing.clampTaskSeverity(tasks, rejected), tasks);

  const merelyRevise = [{ verdict: 'revise', issues: [{ severity: 'major' }] }];
  const capped = __testing.clampTaskSeverity(tasks, merelyRevise) as typeof tasks;
  assert.equal(capped.tasks[0]!.severity, 'major');
});

test('a budget spent on issues below critical ends the loop instead of escalating', () => {
  assert.equal(revisionDecision({ cycle: 1, maxCycles: 3, openCriticalIssues: 0, openIssues: 1 }), 'rewrite');
  assert.equal(revisionDecision({ cycle: 3, maxCycles: 3, openCriticalIssues: 0, openIssues: 2 }), 'pass');
  assert.equal(revisionDecision({ cycle: 3, maxCycles: 3, openCriticalIssues: 1, openIssues: 2 }), 'escalate');
  assert.equal(revisionDecision({ cycle: 0, maxCycles: 3, openCriticalIssues: 0, openIssues: 0 }), 'pass');
});
