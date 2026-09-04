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
