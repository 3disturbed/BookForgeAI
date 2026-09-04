import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { assemblePageModel, manuscriptDigest, normaliseHeading, pageDigest } from '../domain/page-model.js';

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


test('context digests carry only what their agent acts on', async () => {
  const { __testing } = await import('../agents/runner.js');
  const outline = {
    chapters: [
      { number: 1, title: 'A', summary: 'a', beats: ['x'] },
      { number: 2, title: 'B', summary: 'b', beats: ['y'] },
      { number: 3, title: 'C', summary: 'c', beats: ['z'] },
    ],
  };
  assert.deepEqual(__testing.bookSpine(outline), [
    { number: 1, title: 'A', summary: 'a' },
    { number: 2, title: 'B', summary: 'b' },
    { number: 3, title: 'C', summary: 'c' },
  ]);
  const last = __testing.outlineNeighbours(outline, 3);
  assert.equal(last.previous?.number, 2);
  assert.equal(last.next, null);
  assert.deepEqual(__testing.outlineNeighbours(null, 1), { previous: null, next: null });

  const registry = {
    assets: [
      { name: 'Mara', type: 'character', importance: 'primary', canonicalDescription: { hair: 'grey' } },
      { name: 'Barrel', type: 'prop', importance: 'background', canonicalDescription: {} },
    ],
  };
  assert.deepEqual(__testing.assetRegistryDigest(registry), {
    assets: [
      { name: 'Mara', type: 'character', importance: 'primary' },
      { name: 'Barrel', type: 'prop', importance: 'background' },
    ],
  });
  assert.deepEqual(__testing.registryForProse(registry).assets?.map((a) => a.name), ['Mara']);
  assert.deepEqual(__testing.registryForProse(null), { assets: [] });

  const map = {
    entities: [{ name: 'Mara Vell', kind: 'character', description: 'long', aliases: ['Mara'] }],
    locations: [{ name: 'Kell Point', description: 'shale' }],
  };
  assert.deepEqual(__testing.canonicalNamesDigest(map), {
    entities: [{ name: 'Mara Vell', kind: 'character', aliases: ['Mara'] }],
    locations: ['Kell Point'],
  });
  assert.deepEqual(__testing.canonicalNamesDigest(null), { entities: [], locations: [] });

  // A scene render keeps the identity facts and the author-curated negatives;
  // only the reference-sheet prompts are the designer's own business.
  assert.deepEqual(
    __testing.packageForScenes({
      assetName: 'Mara', bible: { eyes: 'grey' }, referencePrompts: ['x'], negativePrompts: ['spectacles'],
    }),
    { assetName: 'Mara', bible: { eyes: 'grey' }, negativePrompts: ['spectacles'] },
  );
  assert.deepEqual(
    __testing.packageForScenes({ assetName: 'Mara', bible: {} }),
    { assetName: 'Mara', bible: {}, negativePrompts: [] },
  );
});

test('the page model is assembled from the manuscript, never retyped', () => {
  const chapters = [
    {
      number: 1, title: 'The Watch',
      blocks: [
        { type: 'heading', text: 'The Watch', level: 2 },
        { type: 'paragraph', text: 'The lamp turned all night.' },
        { type: 'break', text: '' },
        { type: 'dialogue', text: '"You saw it too," she said.' },
        { type: 'paragraph', text: 'By morning the water had gone the colour of old tin.' },
      ],
    },
    { number: 2, title: 'The Answer', blocks: [{ type: 'paragraph', text: 'Something answered.' }] },
  ];

  // Layout sees lengths and headings, not prose; a heading that repeats the title is marked.
  const digest = manuscriptDigest(chapters);
  assert.equal(JSON.stringify(digest).includes('The lamp turned'), false);
  assert.deepEqual(digest[0]!.blocks[0], { i: 0, type: 'heading', words: 2, text: 'The Watch', level: 2, isTitle: true });
  assert.deepEqual(digest[0]!.blocks[1], { i: 1, type: 'paragraph', words: 5 });

  const planned = {
    template: 'novel', pageSize: 'digest', margins: { top: 1, bottom: 1, inner: 1, outer: 1 },
    pages: [
      { index: 1, kind: 'cover', blocks: [{ type: 'heading', text: 'Book', level: 1 }] },
      // Layout wrote its own chapter heading and left the title block out,
      // skipped block 2, and reversed a range.
      {
        index: 2, kind: 'body',
        blocks: [
          { type: 'heading', text: '1. The Watch', level: 2 },
          { type: 'text', text: '', ref: { chapter: 1, from: 1, to: 1 } },
          { type: 'text', text: '', ref: { chapter: 1, from: 4, to: 3 } },
          { type: 'page_number', text: '9' },
        ],
      },
      // Prose already placed, again: placed once, and the emptied page is dropped.
      { index: 3, kind: 'body', blocks: [{ type: 'text', text: '', ref: { chapter: 1, from: 3, to: 4 } }] },
      { index: 4, kind: 'back_matter', blocks: [{ type: 'text', text: 'The end.' }] },
    ],
  };
  const { data, relocated } = assemblePageModel(planned, chapters);
  const model = data as typeof planned;

  assert.deepEqual(model.pages.map((p) => p.kind), ['cover', 'body', 'body', 'back_matter']);
  assert.deepEqual(model.pages.map((p) => p.index), [1, 2, 3, 4], 'pages are renumbered after the drop');
  assert.deepEqual(model.pages[1]!.blocks, [
    { type: 'heading', text: '1. The Watch', level: 2 },
    { type: 'text', text: 'The lamp turned all night.' },
    { type: 'decoration', text: '' },
    { type: 'text', text: '"You saw it too," she said.' },
    { type: 'text', text: 'By morning the water had gone the colour of old tin.' },
    { type: 'page_number', text: '2' },
  ], 'the skipped break is back in place, the reversed range reads in order, the folio follows the page');
  assert.equal(relocated, 2, 'the skipped break and the chapter never referred to');

  // Chapter 2 was never referred to: a page of its own after chapter 1, before the back matter.
  assert.deepEqual(model.pages[2], {
    index: 3, kind: 'body',
    blocks: [{ type: 'heading', text: '2. The Answer', level: 2 }, { type: 'text', text: 'Something answered.' }],
  });
  assert.ok(model.pages.every((p) => p.blocks.every((b) => !('ref' in b))), 'no reference survives assembly');

  // Two chapters claiming one number cannot hide each other's prose.
  const clash = assemblePageModel(
    { pages: [{ index: 1, kind: 'body', blocks: [{ type: 'text', text: '', ref: { chapter: 1, from: 0, to: 0 } }] }] },
    [
      { number: 1, title: 'A', blocks: [{ type: 'paragraph', text: 'First.' }] },
      { number: 1, title: 'B', blocks: [{ type: 'paragraph', text: 'Second.' }] },
    ],
  );
  const clashed = clash.data as { pages: { blocks: { text?: string }[] }[] };
  assert.deepEqual(clashed.pages.flatMap((p) => p.blocks.map((b) => b.text)), ['First.', '1. B', 'Second.']);
  assert.equal(clash.relocated, 1);

  // A manuscript heading that repeats the layout's own chapter heading is not set twice.
  const titled = assemblePageModel(
    {
      pages: [{
        index: 1, kind: 'body',
        blocks: [
          { type: 'heading', text: 'Chapter 6: Hidden Paths', level: 2 },
          { type: 'text', text: '', ref: { chapter: 6, from: 0, to: 1 } },
        ],
      }],
    },
    [{
      number: 6, title: 'Hidden Paths',
      blocks: [{ type: 'heading', text: 'Hidden Paths', level: 2 }, { type: 'paragraph', text: 'Knock.' }],
    }],
  );
  const titledPages = (titled.data as { pages: { blocks: { text?: string }[] }[] }).pages;
  assert.deepEqual(titledPages[0]!.blocks.map((b) => b.text), ['Chapter 6: Hidden Paths', 'Knock.']);
  assert.equal(titled.relocated, 0);

  // Proof sees structure, plus the text on pages that carry no prose, and the folios.
  const proof = pageDigest(model);
  assert.equal(JSON.stringify(proof).includes('The lamp turned'), false);
  assert.deepEqual(proof.pages[1]!.blocks[1], { type: 'text', words: 5 });
  assert.deepEqual(proof.pages[1]!.blocks[5], { type: 'page_number', text: '2' });
  assert.deepEqual(proof.pages[3]!.blocks[0], { type: 'text', text: 'The end.' });
});

test('assembly repairs what the layout got wrong without doubling anything', () => {
  const chapters = [
    { number: 3, title: 'Three', blocks: [{ type: 'paragraph', text: 'Three one.' }, { type: 'paragraph', text: 'Three two.' }] },
    { number: 4, title: 'The Storm', blocks: [{ type: 'paragraph', text: 'Storm one.' }, { type: 'paragraph', text: 'Storm two.' }] },
    { number: 5, title: 'Five', blocks: [{ type: 'paragraph', text: 'Five one.' }] },
  ];
  const page = (index: number, blocks: unknown[], kind = 'body') => ({ index, kind, blocks });
  const texts = (data: unknown) =>
    (data as { pages: { blocks: { text?: string }[] }[] }).pages.map((p) => p.blocks.map((b) => b.text ?? ''));

  // A chapter whose references all failed keeps the page the layout opened for it.
  const mistyped = assemblePageModel({ pages: [
    page(1, [{ type: 'heading', text: '3. Three', level: 2 }, { type: 'text', ref: { chapter: 3, from: 0, to: 1 } }]),
    page(2, [{ type: 'heading', text: '4. The Storm', level: 2 }, { type: 'text', ref: { chapter: 40, from: 0, to: 1 } }]),
    page(3, [{ type: 'heading', text: '5. Five', level: 2 }, { type: 'text', ref: { chapter: 5, from: 0, to: 0 } }]),
  ] }, chapters);
  assert.deepEqual(texts(mistyped.data), [
    ['3. Three', 'Three one.', 'Three two.'],
    ['4. The Storm', 'Storm one.', 'Storm two.'],
    ['5. Five', 'Five one.'],
  ]);
  assert.equal(mistyped.relocated, 2);

  // A chapter the layout forgot goes in before the next one, so a plate stays with the chapter before it.
  const forgotten = assemblePageModel({ pages: [
    page(1, [{ type: 'text', ref: { chapter: 3, from: 0, to: 1 } }]),
    page(2, [{ type: 'image', storageKey: 'k' }, { type: 'caption', text: 'Three, illustrated.' }], 'plate'),
    page(3, [{ type: 'heading', text: '5. Five', level: 2 }, { type: 'text', ref: { chapter: 5, from: 0, to: 0 } }]),
  ] }, chapters);
  assert.deepEqual(texts(forgotten.data), [
    ['Three one.', 'Three two.'],
    ['', 'Three, illustrated.'],
    ['4. The Storm', 'Storm one.', 'Storm two.'],
    ['5. Five', 'Five one.'],
  ]);

  // A page left holding only a folio is not printed.
  const folio = assemblePageModel({ pages: [
    page(1, [{ type: 'text', ref: { chapter: 5, from: 0, to: 0 } }, { type: 'page_number', text: '1' }]),
    page(2, [{ type: 'text', ref: { chapter: 5, from: 0, to: 0 } }, { type: 'page_number', text: '2' }]),
  ] }, [chapters[2]!]);
  assert.equal((folio.data as { pages: unknown[] }).pages.length, 1);

  // Prose the layout typed out instead of referring to is placed once, in the manuscript's bytes.
  const retyped = assemblePageModel({ pages: [
    page(1, [{ type: 'text', text: 'Storm   one.' }, { type: 'text', ref: { chapter: 4, from: 1, to: 1 } }]),
  ] }, [chapters[1]!]);
  assert.deepEqual(texts(retyped.data), [['Storm one.', 'Storm two.']]);
  assert.equal(retyped.relocated, 0);

  // A section heading that repeats the title after prose has begun is an
  // ordinary block: not marked, and put back if the layout leaves it out.
  const titled = [{
    number: 2, title: 'The Crossing',
    blocks: [
      { type: 'heading', text: 'The Crossing', level: 1 },
      { type: 'paragraph', text: 'Before.' },
      { type: 'heading', text: 'The Crossing', level: 3 },
      { type: 'paragraph', text: 'After.' },
    ],
  }];
  assert.deepEqual(manuscriptDigest(titled)[0]!.blocks.map((b) => 'isTitle' in b), [true, false, false, false]);
  const sectioned = assemblePageModel({ pages: [
    page(1, [
      { type: 'heading', text: '2. The Crossing', level: 2 },
      { type: 'text', ref: { chapter: 2, from: 1, to: 1 } },
      { type: 'text', ref: { chapter: 2, from: 3, to: 3 } },
    ]),
  ] }, titled);
  assert.deepEqual(texts(sectioned.data), [['2. The Crossing', 'Before.', 'The Crossing', 'After.']]);
  assert.equal(sectioned.relocated, 1);

  assert.equal(normaliseHeading('Chapter 12'), 'chapter 12', 'a title that is only a number keeps its text');
  assert.equal(normaliseHeading('Chapter 3: The Crossing'), 'the crossing');
});
