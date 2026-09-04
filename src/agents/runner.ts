import { z } from 'zod';
import { agentDefinition, CRITIC_INPUTS, type AgentName } from '../domain/agents.js';
import type { ArtifactKind } from '../domain/artifacts.js';
import { env } from '../domain/env.js';
import { BookForgeError, ContentRefusedError } from '../domain/errors.js';
import { slug } from '../domain/ids.js';
import { schemaFor } from '../domain/schemas.js';
import { stripEmDashesDeep } from '../domain/typography.js';
import { storageKey } from '../domain/storage-paths.js';
import type { UsageRecord } from '../domain/costs.js';
import { asUntrustedData, generateImage, generateStructured } from '../ai/openai.js';
import { loadPrompt, renderPrompt } from '../ai/prompts.js';
import { getBlob, putBlob } from '../storage/blobs.js';
import { renderPdf, type PageModel } from '../pdf/render.js';
import * as repo from '../store/repo.js';

/** Result of one agent execution, before it is committed. */
interface Outcome {
  data: unknown;
  model: string | null;
  promptVersion: string;
  usage: Partial<UsageRecord>;
  /** Overrides the job's scope key for the written artifact. */
  artifactScopeKey?: string | null;
  /** Extra work to run after the artifact is committed. */
  afterCommit?: (artifactId: string) => void | Promise<void>;
}

/* --------------------------- read helpers -------------------------- */

function readSingle<T>(projectId: string, kind: ArtifactKind): T | null {
  return repo.latestArtifact<T>(projectId, kind)?.data ?? null;
}

function requireSingle<T>(projectId: string, kind: ArtifactKind): T {
  const data = readSingle<T>(projectId, kind);
  if (data === null) {
    throw new BookForgeError('MISSING_INPUT', `Required artifact "${kind}" is missing`, 409, { kind });
  }
  return data;
}

/**
 * The current text of a chapter. Editing advances the chapter through
 * successive artifact kinds; the latest one produced wins.
 */
const CHAPTER_TEXT_PRECEDENCE: ArtifactKind[] = [
  'clean_manuscript',
  'edited_manuscript',
  'revised_content',
  'chapter',
];

function currentChapter(projectId: string, scopeKey: string): unknown | null {
  for (const kind of CHAPTER_TEXT_PRECEDENCE) {
    const found = repo.latestArtifact(projectId, kind, scopeKey);
    if (found) return found.data;
  }
  return null;
}

export function chapterScope(number: number): string {
  return `ch${number}`;
}

function critiquesForChapter(projectId: string, chapterKey: string): unknown[] {
  return repo
    .latestArtifactsOfKind(projectId, 'critique')
    .filter((a) => a.scopeKey?.startsWith(`${chapterKey}#`))
    .map((a) => a.data);
}

interface SceneLike {
  key: string;
  chapterNumber: number;
  assets: string[];
  requiredReferences: string[];
  [k: string]: unknown;
}

/** Scene specs are written per chapter; scenes are addressed individually. */
function findScene(projectId: string, sceneKey: string): SceneLike | null {
  for (const artifact of repo.latestArtifactsOfKind<{ scenes: SceneLike[] }>(projectId, 'scene_spec')) {
    const scene = artifact.data.scenes?.find((s) => s.key === sceneKey);
    if (scene) return scene;
  }
  return null;
}

export function allScenes(projectId: string): SceneLike[] {
  return repo
    .latestArtifactsOfKind<{ scenes: SceneLike[] }>(projectId, 'scene_spec')
    .flatMap((a) => a.data.scenes ?? []);
}

/** Approved reference art for the named assets, as image inputs. */
async function referenceImagesFor(projectId: string, assetNames: string[]): Promise<Buffer[]> {
  const wanted = new Set(assetNames.map((n) => n.toLowerCase()));
  const assets = repo
    .listVisualAssets(projectId)
    .filter((a) => wanted.has(a.name.toLowerCase()) && a.status !== 'retired');

  const buffers: Buffer[] = [];
  for (const asset of assets) {
    for (const key of asset.referenceImageKeys.slice(0, 1)) {
      try {
        buffers.push(await getBlob(key));
      } catch {
        // A missing reference is not fatal; Visual QA still checks the render.
      }
    }
  }
  return buffers.slice(0, 4);
}

/* ---------------------------- execution ---------------------------- */

export async function executeAgent(
  project: repo.ProjectRow,
  job: repo.JobRow,
): Promise<Outcome> {
  const name = job.agent as AgentName;
  const def = agentDefinition(name);
  const prompt = loadPrompt(def.promptId);
  const outputSchema = schemaFor(def.writes) as unknown as z.ZodType<unknown>;

  /**
   * The author's answers travel with every agent. Attaching them here rather
   * than to each agent's read list means a new agent cannot forget to honour a
   * decision the author already made.
   */
  const decisions = repo.latestArtifact<{
    answers: { question: string; answer: string; delegated: boolean }[];
  }>(project.id, 'decisions');

  const answered = (decisions?.data.answers ?? []).filter((a) => !a.delegated && a.answer.trim());

  /** Shared path: assemble context, reason, validate, return. */
  const reason = async (contextParts: string[], overrides?: {
    system?: string;
    schema?: z.ZodType<unknown>;
  }): Promise<Outcome> => {
    const parts = answered.length
      ? [...contextParts, asUntrustedData('author_decisions', answered)]
      : contextParts;

    const system = [
      overrides?.system ?? prompt.body,
      answered.length
        ? '\nThe author has already decided the questions in <author_decisions>. ' +
          'Follow those decisions exactly. Do not reopen them or choose otherwise.'
        : '',
    ].join('');

    const result = await generateStructured({
      capability: def.capability,
      system,
      user: parts.join('\n\n'),
      schema: overrides?.schema ?? outputSchema,
    });
    return {
      data: result.data,
      model: result.model,
      promptVersion: prompt.version,
      usage: {
        textInputTokens: result.usage.textInputTokens,
        textOutputTokens: result.usage.textOutputTokens,
      },
    };
  };

  switch (name) {
    /* ------------------------- stage 1-3 ------------------------- */

    case 'discover':
      return reason([
        asUntrustedData('author_idea', project.idea),
        asUntrustedData('author_hints', {
          workingTitle: project.title,
          genre: project.genre,
          audience: project.audience,
        }),
      ]);

    case 'research':
      return reason([asUntrustedData('brief', requireSingle(project.id, 'brief'))]);

    case 'map':
      return reason([
        asUntrustedData('brief', requireSingle(project.id, 'brief')),
        asUntrustedData('research_library', requireSingle(project.id, 'research_library')),
      ]);

    /* ------------------------ structure -------------------------- */

    case 'architect':
      return reason([
        asUntrustedData('brief', requireSingle(project.id, 'brief')),
        asUntrustedData('knowledge_map', requireSingle(project.id, 'knowledge_map')),
      ]);

    case 'design':
      return reason([
        asUntrustedData('brief', requireSingle(project.id, 'brief')),
        asUntrustedData('architecture', requireSingle(project.id, 'architecture')),
      ]);

    case 'outline':
      return reason([
        asUntrustedData('brief', requireSingle(project.id, 'brief')),
        asUntrustedData('architecture', requireSingle(project.id, 'architecture')),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('knowledge_map', requireSingle(project.id, 'knowledge_map')),
      ]);

    /* ----------------------- visual canon ------------------------ */

    case 'visual-canon': {
      const outcome = await reason([
        asUntrustedData('brief', requireSingle(project.id, 'brief')),
        asUntrustedData('knowledge_map', requireSingle(project.id, 'knowledge_map')),
      ]);

      // Registering the assets is what lets the per-asset designer jobs fan out.
      const registry = outcome.data as {
        assets: { name: string; type: string; importance: string; canonicalDescription: Record<string, unknown> }[];
      };
      outcome.afterCommit = () => {
        for (const asset of registry.assets ?? []) {
          repo.upsertVisualAsset({
            projectId: project.id,
            name: asset.name,
            type: asset.type as never,
            importance: asset.importance,
            canonicalDescription: asset.canonicalDescription ?? {},
          });
        }
      };
      return outcome;
    }

    case 'asset-designer': {
      const assetName = job.scopeKey ?? '';
      const asset = repo.listVisualAssets(project.id).find((a) => slug(a.name) === assetName);
      if (!asset) {
        throw new BookForgeError('MISSING_INPUT', `Visual asset "${assetName}" not found`, 409);
      }

      const outcome = await reason([
        asUntrustedData('asset', {
          name: asset.name,
          type: asset.type,
          importance: asset.importance,
          canonicalDescription: asset.canonicalDescription,
        }),
        asUntrustedData('brief', requireSingle(project.id, 'brief')),
      ]);

      // VISUAL_CANON.md: ASSET DESIGN -> REFERENCE GENERATION. The reference
      // sheet is the anchor every later illustration of this asset is matched to.
      const pkg = outcome.data as { referencePrompts: string[]; negativePrompts: string[] };
      if (env().ENABLE_ILLUSTRATIONS && pkg.referencePrompts?.length) {
        try {
          const image = await generateImage({
            prompt: [pkg.referencePrompts[0], negativeClause(pkg.negativePrompts)]
              .filter(Boolean)
              .join(' '),
            aspectRatio: '1:1',
          });
          const key = storageKey(project.id, 'assets', `${slug(asset.name)}-reference.png`);
          await putBlob(key, image.png);
          repo.addAssetReferenceImage(asset.id, key);
          repo.setAssetStatus(asset.id, 'review');
          outcome.usage.imageGenerations = (outcome.usage.imageGenerations ?? 0) + 1;
        } catch (error) {
          // The written bible is the artifact that matters; the reference sheet
          // is enrichment. Innocuous subjects do get refused — a carving knife
          // reads as a weapon — so losing the image must not lose the asset.
          if (!(error instanceof ContentRefusedError)) throw error;
          repo.setAssetStatus(asset.id, 'review');
        }
      }
      return outcome;
    }

    /* -------------------------- writing -------------------------- */

    case 'author': {
      const outline = requireSingle<{ chapters: { number: number }[] }>(project.id, 'outline');
      const chapterNumber = Number(job.scopeKey?.replace(/^ch/, '') ?? 0);
      const chapter = outline.chapters?.find((c) => c.number === chapterNumber);
      if (!chapter) {
        throw new BookForgeError('MISSING_INPUT', `Outline has no chapter ${chapterNumber}`, 409);
      }

      return reason([
        asUntrustedData('chapter_outline', chapter),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('knowledge_map', requireSingle(project.id, 'knowledge_map')),
        asUntrustedData('asset_registry', readSingle(project.id, 'asset_registry') ?? {}),
        asUntrustedData('full_outline', outline),
      ]);
    }

    case 'critics': {
      const scope = job.scopeKey ?? '';
      const persona = job.persona ?? 'literary';
      // Each lens reads only the artifacts it can actually act on, which keeps
      // five critics per chapter from re-sending the same context five times.
      const wanted = CRITIC_INPUTS[persona] ?? ['chapter', 'design_spec'];
      const context = wanted.map((kind) =>
        kind === 'chapter'
          ? asUntrustedData('chapter', currentChapter(project.id, scope) ?? {})
          : asUntrustedData(kind, readSingle(project.id, kind) ?? {}),
      );

      return {
        ...(await reason(
          context,
          { system: renderPrompt(prompt.body, { persona }) },
        )),
        // One artifact per persona, so five critics leave five critiques.
        artifactScopeKey: `${scope}#${persona}`,
      };
    }

    case 'diagnosis': {
      const scope = job.scopeKey ?? '';
      return reason([
        asUntrustedData('critiques', critiquesForChapter(project.id, scope)),
        asUntrustedData('chapter', currentChapter(project.id, scope) ?? {}),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('outline', requireSingle(project.id, 'outline')),
      ]);
    }

    case 'rewriter': {
      const scope = job.scopeKey ?? '';
      return reason([
        asUntrustedData('revision_tasks', repo.latestArtifact(project.id, 'revision_tasks', scope)?.data ?? {}),
        asUntrustedData('chapter', currentChapter(project.id, scope) ?? {}),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('knowledge_map', requireSingle(project.id, 'knowledge_map')),
      ]);
    }

    case 'editor':
    case 'copy-editor': {
      const scope = job.scopeKey ?? '';
      return reason([
        asUntrustedData('chapter', currentChapter(project.id, scope) ?? {}),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('knowledge_map', readSingle(project.id, 'knowledge_map') ?? {}),
      ]);
    }

    /* ------------------------ illustration ----------------------- */

    case 'scene-composer': {
      const scope = job.scopeKey ?? '';
      return reason([
        asUntrustedData('chapter', currentChapter(project.id, scope) ?? {}),
        asUntrustedData('asset_registry', readSingle(project.id, 'asset_registry') ?? {}),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('chapter_scope', scope),
      ]);
    }

    case 'image-director': {
      const sceneKey = job.scopeKey ?? '';
      const scene = findScene(project.id, sceneKey);
      if (!scene) throw new BookForgeError('MISSING_INPUT', `Scene "${sceneKey}" not found`, 409);

      const packages = repo
        .latestArtifactsOfKind<{ assetName: string }>(project.id, 'reference_package')
        .filter((p) => scene.assets?.some((a) => slug(a) === p.scopeKey))
        .map((p) => p.data);

      return reason([
        asUntrustedData('scene', scene),
        asUntrustedData('reference_packages', packages),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
      ]);
    }

    case 'image-generator': {
      const sceneKey = job.scopeKey ?? '';
      const spec = repo.latestArtifact<{
        prompt: string;
        negativePrompt: string;
        aspectRatio: string;
        referenceAssetNames: string[];
      }>(project.id, 'image_spec', sceneKey);
      if (!spec) throw new BookForgeError('MISSING_INPUT', `No image spec for "${sceneKey}"`, 409);

      const scene = findScene(project.id, sceneKey);
      const references = await referenceImagesFor(
        project.id,
        spec.data.referenceAssetNames?.length ? spec.data.referenceAssetNames : (scene?.assets ?? []),
      );

      const image = await generateImage({
        prompt: [spec.data.prompt, negativeClause([spec.data.negativePrompt])]
          .filter(Boolean)
          .join(' '),
        aspectRatio: spec.data.aspectRatio,
        references,
      });

      const key = storageKey(project.id, 'illustrations', `${sceneKey}.png`);
      await putBlob(key, image.png);

      return {
        data: {
          sceneKey,
          storageKey: key,
          width: image.width,
          height: image.height,
          mimeType: 'image/png',
          model: image.model,
          revision: (repo.latestArtifact(project.id, 'artwork', sceneKey)?.version ?? 0) + 1,
        },
        model: image.model,
        promptVersion: prompt.version,
        usage: { imageGenerations: 1, imageInputImages: image.referenceCount },
      };
    }

    case 'visual-qa': {
      const sceneKey = job.scopeKey ?? '';
      const artwork = repo.latestArtifact<{ storageKey: string }>(project.id, 'artwork', sceneKey);
      const spec = repo.latestArtifact(project.id, 'image_spec', sceneKey);
      if (!artwork || !spec) {
        throw new BookForgeError('MISSING_INPUT', `No artwork to QA for "${sceneKey}"`, 409);
      }

      const scene = findScene(project.id, sceneKey);
      const packages = repo
        .latestArtifactsOfKind<{ assetName: string }>(project.id, 'reference_package')
        .filter((p) => scene?.assets?.some((a) => slug(a) === p.scopeKey))
        .map((p) => p.data);

      const images = [await getBlob(artwork.data.storageKey)];
      const result = await generateStructured({
        capability: def.capability,
        system: prompt.body,
        user: [
          asUntrustedData('image_spec', spec.data),
          asUntrustedData('scene', scene ?? {}),
          asUntrustedData('reference_packages', packages),
        ].join('\n\n'),
        schema: outputSchema,
        images,
      });

      return {
        data: result.data,
        model: result.model,
        promptVersion: prompt.version,
        usage: {
          textInputTokens: result.usage.textInputTokens,
          textOutputTokens: result.usage.textOutputTokens,
          imageInputImages: images.length,
        },
      };
    }

    /* -------------------- assembly and delivery ------------------- */

    case 'continuity': {
      const chapters = repo
        .latestArtifactsOfKind(project.id, 'clean_manuscript')
        .map((a) => a.data);
      return reason([
        asUntrustedData('manuscript', chapters),
        asUntrustedData('knowledge_map', requireSingle(project.id, 'knowledge_map')),
        asUntrustedData('asset_registry', readSingle(project.id, 'asset_registry') ?? {}),
      ]);
    }

    case 'layout': {
      const chapters = repo
        .latestArtifactsOfKind(project.id, 'clean_manuscript')
        .map((a) => a.data);
      const artwork = repo
        .latestArtifactsOfKind<{ sceneKey: string; storageKey: string }>(project.id, 'artwork')
        .map((a) => a.data);
      const approved = new Set(
        repo
          .latestArtifactsOfKind<{ sceneKey: string; passed: boolean }>(project.id, 'visual_qa_result')
          .filter((q) => q.data.passed)
          .map((q) => q.data.sceneKey),
      );

      return reason([
        asUntrustedData('brief', requireSingle(project.id, 'brief')),
        asUntrustedData('architecture', requireSingle(project.id, 'architecture')),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('manuscript', chapters),
        // Only QA-approved artwork is offered to layout.
        asUntrustedData('available_illustrations', artwork.filter((a) => approved.has(a.sceneKey))),
      ]);
    }

    case 'proof': {
      const pageModel = requireSingle<PageModel>(project.id, 'page_model');

      // PDF_PIPELINE.md proofs the rendered document, so the render happens
      // here rather than as a fire-and-forget side effect: it is awaited, it
      // retries with the job, and a failure surfaces as a failed job.
      const render = await renderPdf(pageModel);
      const key = storageKey(project.id, 'renders', 'edition-draft.pdf');
      await putBlob(key, render.pdf);

      repo.recordEvent({
        projectId: project.id,
        type: 'PDF_RENDERED',
        actor: 'system',
        payload: {
          pageCount: render.pageCount,
          engine: render.engine,
          missingImages: render.missingImages,
          storageKey: key,
        },
      });

      return reason([
        asUntrustedData('rendered_pdf', {
          pageCount: render.pageCount,
          engine: render.engine,
          missingImages: render.missingImages,
        }),
        asUntrustedData('planned_pages', pageModel.pages?.length ?? 0),
        asUntrustedData('page_model', pageModel.pages),
      ]);
    }

    case 'publisher':
      return reason([
        asUntrustedData('brief', requireSingle(project.id, 'brief')),
        asUntrustedData('proof_report', readSingle(project.id, 'pdf_proof_report') ?? {}),
      ]);

    default: {
      const exhaustive: never = name;
      throw new BookForgeError('UNKNOWN_AGENT', `No handler for agent "${String(exhaustive)}"`, 500);
    }
  }
}

/** Chapter-shaped artifacts, whose word count is derived rather than trusted. */
const CHAPTER_KINDS: ReadonlySet<string> = new Set([
  'chapter', 'revised_content', 'edited_manuscript', 'clean_manuscript',
]);

/**
 * Models report `wordCount` inconsistently — sometimes omitted, sometimes a
 * summary of what they intended to write rather than what they wrote. The
 * count is displayed to users and used to judge length against the brief, so
 * it is recomputed from the committed text.
 */
function normaliseArtifact(kind: string, data: unknown): unknown {
  // House style is enforced on every artifact, not just prose: headings,
  // captions, blurbs and notes all reach the finished PDF.
  const value = stripEmDashesDeep(data);

  if (!CHAPTER_KINDS.has(kind) || typeof value !== 'object' || value === null) return value;

  const chapter = value as { blocks?: { text?: string }[]; wordCount?: number };
  if (!Array.isArray(chapter.blocks)) return value;

  const wordCount = chapter.blocks.reduce(
    (total, block) => total + (String(block?.text ?? '').match(/\S+/g)?.length ?? 0),
    0,
  );
  return { ...chapter, wordCount };
}

function negativeClause(negatives: (string | undefined)[]): string {
  const items = negatives.filter((n): n is string => Boolean(n && n.trim()));
  return items.length ? `Avoid: ${items.join('; ')}.` : '';
}

/* ----------------------------- driver ------------------------------ */

const MAX_RETRIES = 2;

/**
 * Runs one job end to end: READ -> REASON -> VALIDATE -> WRITE ARTIFACT ->
 * REPORT (AGENTS.md). Every job records its model, prompt version, usage and
 * outcome so a run is auditable (SDD.md §9).
 */
export async function runJob(job: repo.JobRow): Promise<void> {
  const project = repo.getProject(job.projectId);
  if (!project) {
    repo.failJob(job.id, 'Project no longer exists', false);
    return;
  }

  const startedAt = Date.now();

  try {
    const outcome = await executeAgent(project, job);
    const def = agentDefinition(job.agent as AgentName);

    const artifact = repo.writeArtifact({
      projectId: project.id,
      kind: def.writes,
      scopeKey: outcome.artifactScopeKey !== undefined ? outcome.artifactScopeKey : job.scopeKey,
      data: normaliseArtifact(def.writes, outcome.data),
      producedByJobId: job.id,
    });

    await outcome.afterCommit?.(artifact.id);

    const usage = {
      ...outcome.usage,
      computeSeconds: (Date.now() - startedAt) / 1000,
    };

    repo.completeJob(job.id, {
      outputArtifactIds: [artifact.id],
      model: outcome.model,
      promptVersion: `${def.promptId}@${outcome.promptVersion}`,
      usage,
    });
    repo.recordUsage({ projectId: project.id, jobId: job.id, usage });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = isRetryable(error) && job.retryCount < MAX_RETRIES;
    repo.failJob(job.id, message, retryable);
  }
}

/**
 * Missing inputs and unconfigured services will not fix themselves on retry;
 * transport and rate-limit failures usually will.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof BookForgeError) {
    return ![
      'MISSING_INPUT', 'OPENAI_NOT_CONFIGURED', 'PROMPT_MISSING', 'UNKNOWN_AGENT',
      // Retrying an identical prompt earns an identical refusal.
      'CONTENT_REFUSED',
    ].includes(error.code);
  }
  return true;
}

/** Exposed for unit tests only. */
export const __testing = { normaliseArtifact };
