import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { evaluateAcceptance } from '../domain/acceptance.js';
import { AGENTS, type AgentName } from '../domain/agents.js';
import { marginFromLines, priceLine } from '../domain/costs.js';
import { env, isOpenAiConfigured, isStripeConfigured, ratesFromEnv } from '../domain/env.js';
import { BadRequestError, BookForgeError, NotFoundError, PreconditionError } from '../domain/errors.js';
import { slug } from '../domain/ids.js';
import { ORDERED_STAGES, STAGE_IDS, STAGES } from '../domain/pipeline.js';
import { APPROVAL_GATES, type ApprovalGate } from '../domain/states.js';
import { storageKey } from '../domain/storage-paths.js';
import { confirmPayment, createCheckoutSession, verifyWebhook } from '../billing/checkout.js';
import { advanceProject, applyApproval, workerStatus } from '../queue/orchestrator.js';
import { blobExists, blobExistsSync, putBlob, signedUrlFor } from '../storage/blobs.js';
import { generateImage } from '../ai/openai.js';
import * as repo from '../store/repo.js';
import { issueSession, clearSession, currentUserId, ownedProject, requireUser, userIdOf } from './auth.js';
import { validateAnswers } from './decisions.js';
import { deriveCorrections } from '../domain/terms.js';

export const api = Router();

/** Express 5 types route params as `string | string[]`; routes here are single-valued. */
function param(req: Request, name: string): string {
  const value = req.params[name];
  const single = Array.isArray(value) ? value[0] : value;
  if (!single) throw new BadRequestError(`Missing route parameter "${name}"`);
  return single;
}

/* ----------------------------- session ----------------------------- */

api.post('/session', (req: Request, res: Response) => {
  const body = z.object({ email: z.string().min(3).max(200) }).safeParse(req.body);
  if (!body.success) throw new BadRequestError('An email address is required');

  const user = repo.upsertUser(body.data.email.trim().toLowerCase());
  issueSession(res, user.id);
  res.json({ id: user.id, email: user.email });
});

api.get('/session', (req: Request, res: Response) => {
  const userId = currentUserId(req);
  res.json(userId ? { id: userId } : null);
});

api.post('/session/logout', (_req: Request, res: Response) => {
  clearSession(res);
  res.json({ ok: true });
});

/* ------------------------------ config ----------------------------- */

api.get('/config', (_req: Request, res: Response) => {
  const config = env();
  res.json({
    priceUsd: config.BOOK_PUBLISHING_PRICE_USD,
    currency: config.BOOK_PUBLISHING_CURRENCY,
    maxRevisionCycles: config.MAX_REVISION_CYCLES,
    illustrationsEnabled: config.ENABLE_ILLUSTRATIONS,
    openaiConfigured: isOpenAiConfigured(config),
    stripeConfigured: isStripeConfigured(config),
    worker: workerStatus(),
    stages: ORDERED_STAGES.map((s) => ({
      id: s.id, step: s.step, label: s.label, gate: s.gate ?? null,
      agents: s.agents.map((a) => AGENTS[a].label),
    })),
    gates: APPROVAL_GATES,
  });
});

/* ----------------------------- projects ---------------------------- */

api.use(requireUser);

api.get('/projects', (req: Request, res: Response) => {
  const projects = repo.listProjects(userIdOf(req)).map((p) => ({
    id: p.id,
    title: p.title,
    genre: p.genre,
    status: p.status,
    publicationState: p.publicationState,
    completedStages: p.completedStages,
    progress: Math.round((p.completedStages.length / ORDERED_STAGES.length) * 100),
    createdAt: p.createdAt,
  }));
  res.json(projects);
});

api.post('/projects', (req: Request, res: Response) => {
  const body = z
    .object({
      title: z.string().min(1).max(200),
      idea: z.string().min(10).max(20000),
      genre: z.string().max(100).default(''),
      audience: z.string().max(200).default(''),
    })
    .safeParse(req.body);

  if (!body.success) {
    throw new BadRequestError('Give the book a title and describe the idea (10+ characters)', {
      issues: body.error.issues,
    });
  }

  const project = repo.createProject({ userId: userIdOf(req), ...body.data });
  repo.recordEvent({ projectId: project.id, type: 'PROJECT_CREATED', actor: userIdOf(req) });
  advanceProject(project.id);
  res.status(201).json(snapshot(req, project.id));
});

api.get('/projects/:id', (req: Request, res: Response) => {
  ownedProject(req, param(req, 'id'));
  res.json(snapshot(req, param(req, 'id')));
});

api.post('/projects/:id/advance', (req: Request, res: Response) => {
  ownedProject(req, param(req, 'id'));
  advanceProject(param(req, 'id'));
  res.json(snapshot(req, param(req, 'id')));
});

/**
 * Puts a stalled project back in motion. A failed job on a required agent stops
 * the pipeline for good otherwise: the scheduler will not step past it, and a
 * restart only rescues jobs interrupted mid-flight.
 */
api.post('/projects/:id/retry', (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));

  const body = z.object({ stage: z.enum(STAGE_IDS).optional() }).safeParse(req.body ?? {});
  if (!body.success) throw new BadRequestError('Unknown stage');

  const requeued = repo.retryFailedJobs(project.id, body.data.stage);
  if (requeued > 0) {
    repo.updateProject(project.id, { status: 'forging' });
    advanceProject(project.id);
  }

  res.json({ requeued, ...snapshot(req, project.id) });
});

/**
 * Applies the project's spelling decisions to work already written.
 *
 * Answering a naming question does not travel backwards on its own: artifacts
 * produced before the answer keep the wrong spelling, and downstream agents
 * read those as canon. Visual assets are corrected too, including locked ones,
 * since a locked asset with the wrong name cannot be fixed any other way.
 */
api.post('/projects/:id/repair-terms', (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));

  const body = z
    .object({
      corrections: z
        .array(z.object({ wrong: z.string().min(1).max(200), right: z.string().min(1).max(200) }))
        .optional(),
    })
    .safeParse(req.body ?? {});
  if (!body.success) throw new BadRequestError('Corrections must be {wrong, right} pairs');

  const decisions = repo.latestArtifact<{
    answers: { question: string; answer: string; delegated: boolean }[];
  }>(project.id, 'decisions');

  // Explicit corrections win, so a term that was never a question can be fixed.
  const corrections = body.data.corrections ?? (decisions?.data.answers ?? [])
    .filter((a) => !a.delegated && a.answer.trim())
    .flatMap((a) => deriveCorrections(a.question, a.answer));

  if (corrections.length === 0) {
    res.json({ corrections: [], artifactsRewritten: 0, assetsRenamed: 0 });
    return;
  }

  const { artifacts, assets } = repo.applyTermCorrections(project.id, corrections);

  repo.recordEvent({
    projectId: project.id,
    type: 'VISUAL_ASSET_APPROVED',
    actor: userIdOf(req),
    payload: { repairedTerms: corrections, artifacts, assets },
  });

  res.json({
    corrections,
    artifactsRewritten: artifacts,
    assetsRenamed: assets,
    ...snapshot(req, project.id),
  });
});

/* ---------------------------- approvals ---------------------------- */

api.post('/projects/:id/approvals', (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));
  const body = z
    .object({
      gate: z.enum(APPROVAL_GATES),
      approved: z.boolean(),
      note: z.string().max(2000).default(''),
    })
    .safeParse(req.body);

  if (!body.success) throw new BadRequestError('Unknown approval gate');

  applyApproval({
    projectId: project.id,
    gate: body.data.gate,
    approved: body.data.approved,
    actor: userIdOf(req),
    note: body.data.note,
  });

  res.json(snapshot(req, project.id));
});

/* ---------------------------- decisions ---------------------------- */

/**
 * The Discover agent raises questions it wants a human to settle. Approving the
 * brief without answering them lets every later agent invent its own answer, so
 * they are surfaced at the gate and recorded here.
 */
api.get('/projects/:id/decisions', (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));
  res.json(openQuestionsFor(project.id));
});

api.post('/projects/:id/decisions', (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));

  const body = z
    .object({
      answers: z
        .array(
          z.object({
            question: z.string().min(1).max(2000),
            answer: z.string().max(4000).default(''),
            delegated: z.boolean().default(false),
          }),
        )
        .min(1),
    })
    .safeParse(req.body);

  if (!body.success) throw new BadRequestError('Provide answers to record');

  // Answers are matched to questions by exact text. An answer to a question the
  // brief never asked would be stored and then silently ignored, so reject it
  // rather than let a typo look like a saved decision.
  validateAnswers(
    repo.latestArtifact<{ openQuestions?: string[] }>(project.id, 'brief')?.data.openQuestions ?? [],
    body.data.answers,
  );

  const now = new Date().toISOString();
  // Merge onto what is already recorded so answering one at a time works.
  const existing = repo.latestArtifact<{ answers: AnswerRow[] }>(project.id, 'decisions');
  const merged = new Map<string, AnswerRow>(
    (existing?.data.answers ?? []).map((a) => [a.question, a]),
  );
  for (const a of body.data.answers) {
    merged.set(a.question, { ...a, answeredAt: now });
  }

  repo.writeArtifact({
    projectId: project.id,
    kind: 'decisions',
    data: { answers: [...merged.values()] },
    producedByJobId: null,
  });

  repo.recordEvent({
    projectId: project.id,
    type: 'BRIEF_CREATED',
    actor: userIdOf(req),
    payload: { decisions: body.data.answers.length },
  });

  advanceProject(project.id);
  res.json(openQuestionsFor(project.id));
});

interface AnswerRow {
  question: string;
  answer: string;
  delegated: boolean;
  answeredAt: string;
}

function openQuestionsFor(projectId: string) {
  const brief = repo.latestArtifact<{ openQuestions?: string[] }>(projectId, 'brief');
  const decisions = repo.latestArtifact<{ answers: AnswerRow[] }>(projectId, 'decisions');
  const byQuestion = new Map((decisions?.data.answers ?? []).map((a) => [a.question, a]));

  const questions = (brief?.data.openQuestions ?? []).map((question) => {
    const recorded = byQuestion.get(question);
    return {
      question,
      answer: recorded?.answer ?? '',
      delegated: recorded?.delegated ?? false,
      answered: Boolean(recorded && (recorded.delegated || recorded.answer.trim())),
    };
  });

  const corrections = questions
    .filter((q) => q.answered && !q.delegated)
    .flatMap((q) => deriveCorrections(q.question, q.answer));

  return {
    questions,
    unanswered: questions.filter((q) => !q.answered).length,
    /** Spellings enforced on every artifact as a result of these answers. */
    corrections,
  };
}

/**
 * Re-renders one canon asset's reference sheet, optionally from a prompt the
 * author has edited. The reference sheet is what every later illustration of
 * that asset is matched against, so being able to steer it is the difference
 * between accepting the model's first idea and directing the book's look.
 */
api.post('/projects/:id/assets/:assetId/regenerate', async (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));
  const asset = repo.getVisualAsset(param(req, 'assetId'));
  if (!asset || asset.projectId !== project.id) throw new NotFoundError('visual asset');
  // The manual path honours the same kill switch as the pipeline's image steps.
  if (!env().ENABLE_ILLUSTRATIONS) {
    throw new PreconditionError('Illustrations are disabled (ENABLE_ILLUSTRATIONS=false)');
  }

  const body = z
    .object({
      prompt: z.string().min(1).max(4000).optional(),
      negativePrompt: z.string().max(2000).optional(),
    })
    .safeParse(req.body ?? {});
  if (!body.success) throw new BadRequestError('Provide a prompt to render');

  const existing = repo.latestArtifact<{
    assetName: string;
    bible: Record<string, unknown>;
    referencePrompts: string[];
    negativePrompts: string[];
  }>(project.id, 'reference_package', slug(asset.name));

  const prompt = body.data.prompt ?? existing?.data.referencePrompts?.[0];
  if (!prompt) {
    throw new BadRequestError('This asset has no reference prompt yet; supply one');
  }
  const negatives = body.data.negativePrompt !== undefined
    ? [body.data.negativePrompt].filter(Boolean)
    : (existing?.data.negativePrompts ?? []);

  const negativeClause = negatives.length ? ` Avoid: ${negatives.join('; ')}.` : '';
  const image = await generateImage({ prompt: prompt + negativeClause, aspectRatio: '1:1' });

  // A new file each time, so the previous sheet stays available for comparison.
  const key = storageKey(
    project.id, 'assets', `${slug(asset.name)}-reference-v${asset.version + 1}.png`,
  );
  await putBlob(key, image.png);
  repo.promoteAssetReferenceImage(asset.id, key);

  // An edited prompt becomes the asset's canonical one.
  if (existing && (body.data.prompt || body.data.negativePrompt !== undefined)) {
    repo.writeArtifact({
      projectId: project.id,
      kind: 'reference_package',
      scopeKey: slug(asset.name),
      producedByJobId: null,
      data: { ...existing.data, referencePrompts: [prompt], negativePrompts: negatives },
    });
  }

  // New artwork is a change, so the canon needs approving again.
  repo.setAssetStatus(asset.id, 'review');
  repo.setApproval({
    projectId: project.id, gate: 'visual_canon', approved: false,
    actor: userIdOf(req), note: `regenerated ${asset.name}`,
  });

  repo.recordUsage({
    projectId: project.id,
    jobId: null,
    agent: 'asset-regenerate',
    capability: 'image',
    model: image.model,
    usage: {
      imageGenerations: 1,
      imageCalls: image.imageCalls,
      imageInputImages: image.referenceCount,
      imageInputTokens: image.usage.imageInputTokens,
      imageTextInputTokens: image.usage.imageTextInputTokens,
      imageOutputTokens: image.usage.imageOutputTokens,
      modelLatencySeconds: image.latencySeconds,
    },
  });

  res.json({
    asset: repo.getVisualAsset(asset.id),
    url: signedUrlFor(key, project.id).url,
    prompt,
    negativePrompts: negatives,
  });
});

/* ------------------------------ usage ------------------------------ */

/**
 * Where a book's money went: one line per agent, tier, model and mode, with
 * failed attempts counted rather than hidden. Rates come from RATE_* and the
 * response says whether any have been entered, so zeros are never mistaken
 * for free.
 */
api.get('/projects/:id/usage', (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));
  const lines = repo.usageBreakdown(project.id);
  const rates = ratesFromEnv();
  res.json({
    lines: lines.map((line) => ({ ...line, cost: priceLine(line, rates) })),
    total: repo.totalUsage(project.id),
    economics: marginFromLines(lines, rates, env().BOOK_PUBLISHING_PRICE_USD),
  });
});

/* ---------------------------- artifacts ---------------------------- */

api.get('/projects/:id/artifacts/:kind', (req: Request, res: Response) => {
  ownedProject(req, param(req, 'id'));
  const scope = typeof req.query.scope === 'string' ? req.query.scope : null;
  const artifacts = scope
    ? [repo.latestArtifact(param(req, 'id'), param(req, 'kind') as never, scope)].filter(Boolean)
    : repo.latestArtifactsOfKind(param(req, 'id'), param(req, 'kind') as never);
  res.json(artifacts);
});

api.get('/projects/:id/manuscript', (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));
  const kinds = ['clean_manuscript', 'edited_manuscript', 'revised_content', 'chapter'] as const;

  const byScope = new Map<string, unknown>();
  for (const kind of [...kinds].reverse()) {
    for (const artifact of repo.latestArtifactsOfKind(project.id, kind)) {
      if (artifact.scopeKey) byScope.set(artifact.scopeKey, artifact.data);
    }
  }

  const chapters = [...byScope.entries()]
    .map(([scope, data]): Record<string, unknown> => ({
      ...(data as Record<string, unknown>),
      scope,
    }))
    .sort((a, b) => Number(a.number ?? 0) - Number(b.number ?? 0));

  res.json(chapters);
});

api.get('/projects/:id/assets', (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));
  const packages = new Map(
    repo.latestArtifactsOfKind(project.id, 'reference_package').map((p) => [p.scopeKey, p.data]),
  );

  res.json(
    repo.listVisualAssets(project.id).map((asset) => ({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      status: asset.status,
      importance: asset.importance,
      canonicalDescription: asset.canonicalDescription,
      referencePackage: packages.get(slug(asset.name)) ?? null,
      version: asset.version,
      referencePrompt:
        (packages.get(slug(asset.name)) as { referencePrompts?: string[] } | undefined)
          ?.referencePrompts?.[0] ?? '',
      negativePrompt:
        ((packages.get(slug(asset.name)) as { negativePrompts?: string[] } | undefined)
          ?.negativePrompts ?? []).join('; '),
      referenceImages: asset.referenceImageKeys.map((key) => signedUrlFor(key, project.id).url),
    })),
  );
});

api.get('/projects/:id/illustrations', (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));
  const qa = new Map(
    repo
      .latestArtifactsOfKind<{ sceneKey: string }>(project.id, 'visual_qa_result')
      .map((q) => [q.data.sceneKey, q.data]),
  );

  res.json(
    repo
      .latestArtifactsOfKind<{ sceneKey: string; storageKey: string }>(project.id, 'artwork')
      .map((art) => ({
        sceneKey: art.data.sceneKey,
        url: signedUrlFor(art.data.storageKey, project.id).url,
        qa: qa.get(art.data.sceneKey) ?? null,
      })),
  );
});

api.get('/projects/:id/events', (req: Request, res: Response) => {
  ownedProject(req, param(req, 'id'));
  res.json(repo.listEvents(param(req, 'id')));
});

api.get('/projects/:id/jobs', (req: Request, res: Response) => {
  ownedProject(req, param(req, 'id'));
  res.json(repo.listJobs(param(req, 'id')));
});

/* ------------------------------ PDF -------------------------------- */

api.get('/projects/:id/pdf', async (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));

  // The published export takes precedence over the working draft render.
  for (const key of [
    storageKey(project.id, 'exports', 'edition.pdf'),
    storageKey(project.id, 'renders', 'edition-draft.pdf'),
  ]) {
    if (await blobExists(key)) {
      res.json(signedUrlFor(key, project.id));
      return;
    }
  }
  throw new NotFoundError('rendered PDF');
});

/* ---------------------------- publishing --------------------------- */

api.post('/projects/:id/checkout', async (req: Request, res: Response) => {
  const project = ownedProject(req, param(req, 'id'));

  const acceptance = acceptanceFor(project.id);
  // Payment is the last gate, so it is excluded from the pre-checkout check.
  const blockers = acceptance.blockers.filter(
    (b) => b !== 'Payment confirmed' && b !== 'User approves final edition',
  );
  if (blockers.length > 0) {
    throw new PreconditionError('The book has not passed every acceptance check', { blockers });
  }

  res.json(await createCheckoutSession(project.id));
});

/**
 * Development stand-in for the Stripe webhook. Refused in production, where a
 * verified webhook is the only thing that unlocks publication (SECURITY.md).
 */
api.post('/checkout/dev/confirm', (req: Request, res: Response) => {
  if (env().NODE_ENV === 'production' || isStripeConfigured()) {
    throw new BookForgeError('DEV_CHECKOUT_DISABLED', 'Dev checkout is disabled', 403);
  }
  const body = z.object({ sessionId: z.string().min(1) }).safeParse(req.body);
  if (!body.success) throw new BadRequestError('sessionId is required');
  if (!body.data.sessionId.startsWith('dev_')) throw new BadRequestError('Not a dev session');

  const payment = repo.confirmPaymentBySession(body.data.sessionId);
  if (!payment) throw new NotFoundError('checkout session');
  ownedProject(req, payment.projectId);

  const project = confirmPayment(body.data.sessionId);
  if (project) {
    repo.setApproval({
      projectId: project.id, gate: 'publication_payment',
      approved: true, actor: userIdOf(req), note: 'dev checkout',
    });
    repo.updateProject(project.id, { publicationState: 'PUBLISHING', status: 'publishing' });
    repo.recordEvent({ projectId: project.id, type: 'PUBLICATION_STARTED', actor: 'system' });
    advanceProject(project.id);
  }
  res.json(snapshot(req, payment.projectId));
});

/* ---------------------------- snapshots ---------------------------- */

function acceptanceFor(projectId: string) {
  const chapters = repo.latestArtifactsOfKind(projectId, 'clean_manuscript');
  const continuity = repo.latestArtifact<{ passed: boolean }>(projectId, 'continuity_report');
  const proof = repo.latestArtifact<{ passed: boolean }>(projectId, 'pdf_proof_report');
  const approvals = repo.listApprovals(projectId);

  // A page model is a plan, not a document. Check that a PDF actually exists.
  const pdfRendered =
    blobExistsSync(storageKey(projectId, 'exports', 'edition.pdf')) ||
    blobExistsSync(storageKey(projectId, 'renders', 'edition-draft.pdf'));

  const openCritical = repo
    .latestArtifactsOfKind<{ verdict: string; tasks: { severity: string }[] }>(
      projectId,
      'revision_tasks',
    )
    .filter((a) => a.data.verdict === 'revise')
    .reduce((n, a) => n + (a.data.tasks ?? []).filter((t) => t.severity === 'critical').length, 0);

  const artwork = repo.latestArtifactsOfKind(projectId, 'artwork');
  const qaResults = repo.latestArtifactsOfKind<{ passed: boolean }>(projectId, 'visual_qa_result');
  const illustrationsOn = env().ENABLE_ILLUSTRATIONS;

  return evaluateAcceptance({
    hasRequiredContent: chapters.length > 0,
    unresolvedCriticalIssues: openCritical,
    requiredArtworkPresent: illustrationsOn ? artwork.length > 0 : true,
    visualQaPassed: illustrationsOn
      ? qaResults.length > 0 && qaResults.every((q) => q.data.passed)
      : true,
    continuityPassed: continuity?.data.passed ?? false,
    pdfRendered,
    proofPassed: proof?.data.passed ?? false,
    userApprovedFinalEdition: approvals.final_pdf === true,
    paymentConfirmed: repo.isPaymentConfirmed(projectId),
  });
}

/** How long until the soonest backed-off job becomes claimable. */
function nextRetryInSeconds(jobs: repo.JobRow[]): number | null {
  const waits = jobs
    .filter((j) => j.status === 'queued' && j.retryAfter)
    .map((j) => Math.ceil((new Date(j.retryAfter!).getTime() - Date.now()) / 1000))
    .filter((n) => n > 0);
  return waits.length ? Math.min(...waits) : null;
}

function snapshot(req: Request, projectId: string) {
  const project = ownedProject(req, projectId);
  const completed = new Set(project.completedStages);
  const jobs = repo.listJobs(projectId, 500);
  const approvals = repo.listApprovals(projectId);

  const stages = ORDERED_STAGES.map((stage) => {
    const stageJobs = jobs.filter((j) => j.stage === stage.id);
    const done = completed.has(stage.id);
    const active = stageJobs.some((j) => j.status === 'queued' || j.status === 'running');
    const gate = stage.gate ?? null;
    const awaitingApproval = done && Boolean(gate) && approvals[gate!] !== true;

    // A best-effort job failing costs the book an illustration, not the stage.
    // Reporting that as "failed" would misdescribe a pipeline that is fine.
    const broken = stageJobs.filter(
      (j) => (j.status === 'failed' || j.status === 'blocked') &&
        !AGENTS[j.agent as AgentName]?.optional,
    );
    const degraded = stageJobs.filter(
      (j) => j.status === 'failed' && AGENTS[j.agent as AgentName]?.optional,
    );

    return {
      id: stage.id,
      step: stage.step,
      label: stage.label,
      gate,
      state: broken.length ? 'failed'
        : awaitingApproval ? 'awaiting_approval'
        : done ? (degraded.length ? 'degraded' : 'complete')
        : active ? 'running' : 'pending',
      jobs: stageJobs.length,
      done: stageJobs.filter((j) => j.status === 'completed').length,
      degraded: degraded.length,
      retryable: broken.length + degraded.length,
      /** Seconds until the next automatic attempt, when one is pending. */
      retryInSeconds: nextRetryInSeconds(stageJobs),
      errors: [...broken, ...degraded].map((j) => j.error).slice(0, 3),
    };
  });

  const usage = repo.totalUsage(projectId);

  return {
    project: {
      id: project.id,
      title: project.title,
      idea: project.idea,
      genre: project.genre,
      audience: project.audience,
      status: project.status,
      publicationState: project.publicationState,
      revisionCycle: project.revisionCycle,
      editionId: project.editionId,
      createdAt: project.createdAt,
    },
    stages,
    approvals,
    jobCounts: repo.countJobs(projectId),
    acceptance: acceptanceFor(projectId),
    brief: repo.latestArtifact(projectId, 'brief')?.data ?? null,
    decisions: openQuestionsFor(projectId),
    design: repo.latestArtifact(projectId, 'design_spec')?.data ?? null,
    architecture: repo.latestArtifact(projectId, 'architecture')?.data ?? null,
    outline: repo.latestArtifact(projectId, 'outline')?.data ?? null,
    continuity: repo.latestArtifact(projectId, 'continuity_report')?.data ?? null,
    proof: repo.latestArtifact(projectId, 'pdf_proof_report')?.data ?? null,
    edition: project.editionId ? repo.getEdition(project.editionId) : null,
    usage,
    // Priced per ledger line so a gpt-5 / mini mix and batched tokens are each
    // billed at their own rate; an aggregate cannot say which model did what.
    economics: marginFromLines(
      repo.usageBreakdown(projectId), ratesFromEnv(), env().BOOK_PUBLISHING_PRICE_USD,
    ),
    recentJobs: jobs.slice(0, 20).map((j) => ({
      id: j.id, stage: j.stage, agent: j.agent, persona: j.persona,
      scopeKey: j.scopeKey, status: j.status, model: j.model,
      promptVersion: j.promptVersion, error: j.error, finishedAt: j.finishedAt,
    })),
  };
}

export { acceptanceFor, snapshot, verifyWebhook, confirmPayment, STAGES };
