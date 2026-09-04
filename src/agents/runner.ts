import { z } from 'zod';
import {
  agentDefinition, CRITIC_INPUTS, type AgentDefinition, type AgentName,
} from '../domain/agents.js';
import type { ArtifactKind } from '../domain/artifacts.js';
import { env, type ModelCapability } from '../domain/env.js';
import { BookForgeError, ContentRefusedError } from '../domain/errors.js';
import { slug } from '../domain/ids.js';
import { schemaFor } from '../domain/schemas.js';
import { stripEmDashesDeep } from '../domain/typography.js';
import { applyCorrectionsDeep, deriveCorrections, type TermCorrection } from '../domain/terms.js';
import { storageKey } from '../domain/storage-paths.js';
import { addUsage, EMPTY_USAGE, hasSpend, type UsageRecord } from '../domain/costs.js';
import {
  assemblePageModel, manuscriptDigest, pageDigest, type ChapterLike,
} from '../domain/page-model.js';
import { capScenes, mapAssetNames, normaliseSceneAssets, type NamedAsset } from '../domain/scenes.js';
import {
  asUntrustedData, EMPTY_TOKEN_USAGE, emptyImageSink, generateImage, generateStructured,
  type ImageSink, type TokenUsage,
} from '../ai/openai.js';
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
  /** Canonical spellings to enforce on the written artifact. */
  corrections?: readonly TermCorrection[];
  /** Price tier the reasoning call was billed on, for the ledger. */
  capability?: ModelCapability;
}

interface LedgerExtra {
  capability: ModelCapability;
  model: string | null;
  usage: Partial<UsageRecord>;
}

/** Maps a chat call's billed usage onto ledger fields. */
function ledgerFromTokens(u: TokenUsage): Partial<UsageRecord> {
  return {
    textInputTokens: u.textInputTokens,
    cachedInputTokens: u.cachedInputTokens,
    textOutputTokens: u.textOutputTokens,
    reasoningTokens: u.reasoningTokens,
    modelCalls: u.modelCalls,
    modelLatencySeconds: u.latencySeconds,
  };
}

/**
 * Everything a job has been billed so far, held outside the calls that incur
 * it so no throw can lose it. The ledger is written from this on both the
 * success and the failure path: a putBlob failure after a rendered image, or a
 * transport error on a repair retry, still books what the vendor charged.
 */
export interface Spent {
  /** Chat spend on the agent's own tier. */
  text: TokenUsage;
  /** Image spend when the agent's own tier is image (image-generator). */
  image: ImageSink;
  /** Spend on other tiers within the same job (asset-designer's reference render). */
  extra: LedgerExtra[];
}

export const emptySpent = (): Spent => ({
  text: { ...EMPTY_TOKEN_USAGE }, image: emptyImageSink(), extra: [],
});

/** Maps an image sink onto ledger fields; `delivered` is images actually produced. */
function ledgerFromImages(sink: ImageSink, delivered: number, referenceCount = 0): Partial<UsageRecord> {
  return {
    imageGenerations: delivered,
    imageCalls: sink.imageCalls,
    imageInputImages: referenceCount,
    imageInputTokens: sink.usage.imageInputTokens,
    imageTextInputTokens: sink.usage.imageTextInputTokens,
    imageOutputTokens: sink.usage.imageOutputTokens,
    modelLatencySeconds: sink.latencySeconds,
  };
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

/* --------------------------- context digests ------------------------ */

interface OutlineChapter { number: number; title: string; summary: string; [k: string]: unknown }
interface OutlineLike { chapters?: OutlineChapter[] }

/** Number, title and summary per chapter: the shape of the book without its beats. */
function bookSpine(outline: OutlineLike | null): { number: number; title: string; summary: string }[] {
  return (outline?.chapters ?? []).map((c) => ({ number: c.number, title: c.title, summary: c.summary }));
}

/** The chapters either side of this one, in full, so transitions can be written. */
function outlineNeighbours(
  outline: OutlineLike | null,
  chapterNumber: number,
): { previous: OutlineChapter | null; next: OutlineChapter | null } {
  const chapters = outline?.chapters ?? [];
  return {
    previous: chapters.find((c) => c.number === chapterNumber - 1) ?? null,
    next: chapters.find((c) => c.number === chapterNumber + 1) ?? null,
  };
}

interface RegistryLike {
  assets?: { name: string; type: string; importance: string; [k: string]: unknown }[];
}

/** Which assets exist: enough to choose moments, without their canonical descriptions. */
function assetRegistryDigest(registry: RegistryLike | null): {
  assets: { name: string; type: string; importance: string }[];
} {
  return {
    assets: (registry?.assets ?? []).map((a) => ({ name: a.name, type: a.type, importance: a.importance })),
  };
}

/** The registry without background props; prose needs the recurring assets' canon. */
function registryForProse(registry: RegistryLike | null): RegistryLike {
  return { assets: (registry?.assets ?? []).filter((a) => a.importance !== 'background') };
}

interface KnowledgeMapLike {
  entities?: { name: string; kind: string; aliases?: string[]; [k: string]: unknown }[];
  locations?: { name: string; [k: string]: unknown }[];
}

/** Names and aliases only: what standardising spelling needs from the knowledge map. */
function canonicalNamesDigest(map: KnowledgeMapLike | null): {
  entities: { name: string; kind: string; aliases: string[] }[];
  locations: string[];
} {
  return {
    entities: (map?.entities ?? []).map((e) => ({ name: e.name, kind: e.kind, aliases: e.aliases ?? [] })),
    locations: (map?.locations ?? []).map((l) => l.name),
  };
}

interface ReferencePackageLike {
  assetName: string;
  bible: Record<string, unknown>;
  negativePrompts?: string[];
  [k: string]: unknown;
}

/**
 * What a scene render needs from a package: the identity facts and the
 * asset's known failure modes, which are what the author edits at the canon
 * gate. The reference-sheet prompts belong to the designer's own render.
 */
function packageForScenes(pkg: ReferencePackageLike): {
  assetName: string;
  bible: Record<string, unknown>;
  negativePrompts: string[];
} {
  return { assetName: pkg.assetName, bible: pkg.bible, negativePrompts: pkg.negativePrompts ?? [] };
}

interface SceneLike {
  key: string;
  chapterNumber: number;
  assets: string[];
  requiredReferences: string[];
  [k: string]: unknown;
}

/**
 * Scene specs are written per chapter; scenes are addressed individually. The
 * owning artifact's scope names the chapter; the number the model wrote into
 * the scene is not trusted to.
 */
function locateScene(
  projectId: string,
  sceneKey: string,
): { scene: SceneLike; chapterNumber: number } | null {
  for (const artifact of repo.latestArtifactsOfKind<{ scenes: SceneLike[] }>(projectId, 'scene_spec')) {
    const scene = artifact.data.scenes?.find((s) => s.key === sceneKey);
    if (!scene) continue;
    const fromScope = Number(artifact.scopeKey?.replace(/^ch/, ''));
    return { scene, chapterNumber: Number.isFinite(fromScope) ? fromScope : scene.chapterNumber };
  }
  return null;
}

function findScene(projectId: string, sceneKey: string): SceneLike | null {
  return locateScene(projectId, sceneKey)?.scene ?? null;
}

/** The live registry, most important first, as the name mapper wants it. */
function registryAssets(projectId: string): NamedAsset[] {
  const rank: Record<string, number> = { primary: 0, secondary: 1 };
  return repo
    .listVisualAssets(projectId)
    .filter((a) => a.status !== 'retired')
    .sort((a, b) => (rank[a.importance] ?? 2) - (rank[b.importance] ?? 2))
    .map((a) => ({ name: a.name, importance: a.importance }));
}

/**
 * The reference sheet Visual QA judges identity against: the first required
 * reference that has a sheet, else the most important scene asset with one.
 * Background props never qualify, and a missing sheet attaches nothing rather
 * than another asset's.
 */
async function referenceSheetFor(
  projectId: string,
  scene: SceneLike | null,
): Promise<{ assetName: string; png: Buffer } | null> {
  if (!scene) return null;
  const rank: Record<string, number> = { primary: 0, secondary: 1 };
  const rows = repo.listVisualAssets(projectId).filter((a) => a.status !== 'retired');
  const bySlug = new Map(rows.map((a) => [slug(a.name), a]));
  const inScene = new Set((scene.assets ?? []).map((n) => slug(n)));
  const ordered = [
    ...(scene.requiredReferences ?? []).map((n) => bySlug.get(slug(n))),
    ...rows
      .filter((a) => inScene.has(slug(a.name)))
      .sort((a, b) => (rank[a.importance] ?? 2) - (rank[b.importance] ?? 2)),
  ].filter((a): a is repo.VisualAssetRow => a !== undefined && (rank[a.importance] ?? 2) < 2);
  for (const asset of ordered) {
    const key = asset.referenceImageKeys[0];
    if (!key) continue;
    try {
      return { assetName: asset.name, png: await getBlob(key) };
    } catch {
      // A sheet that cannot be read is not fatal; QA judges from the bible.
    }
  }
  return null;
}

/**
 * Registry entries for a scene's assets that have no reference package, keyed
 * by the packages' artifact scopes (the registry's spelling), not by the name
 * the designer echoed into them. Background props get none, by design.
 */
function canonForUnpackaged(
  projectId: string,
  scene: SceneLike | null,
  packagedScopes: readonly string[],
): { name: string; type: string; importance: string; canonicalDescription: Record<string, unknown> }[] {
  const packaged = new Set(packagedScopes);
  const wanted = new Set((scene?.assets ?? []).map((a) => slug(a)).filter((k) => !packaged.has(k)));
  return repo
    .listVisualAssets(projectId)
    .filter((a) => wanted.has(slug(a.name)))
    .map((a) => ({
      name: a.name, type: a.type, importance: a.importance, canonicalDescription: a.canonicalDescription,
    }));
}

export function allScenes(projectId: string): SceneLike[] {
  return repo
    .latestArtifactsOfKind<{ scenes: SceneLike[] }>(projectId, 'scene_spec')
    .flatMap((a) => a.data.scenes ?? []);
}

/** Approved reference art for the named assets, as image inputs. */
async function referenceImagesFor(projectId: string, assetNames: string[]): Promise<Buffer[]> {
  const wanted = new Set(assetNames.map((n) => n.toLowerCase()));
  const rank: Record<string, number> = { primary: 0, secondary: 1 };
  const assets = repo
    .listVisualAssets(projectId)
    .filter((a) => wanted.has(a.name.toLowerCase()) && a.status !== 'retired')
    // Only four references are sent; the canon that matters most goes first.
    .sort((a, b) => (rank[a.importance] ?? 2) - (rank[b.importance] ?? 2));

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
  /** Accumulates spend as calls return; runJob reads it on failure. */
  spent?: Spent,
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

  // Spelling decisions are enforced on the output rather than trusted to it.
  const corrections = answered.flatMap((a) => deriveCorrections(a.question, a.answer));

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
      corrections.length
        ? '\nUse these exact spellings, even where another spelling looks more ' +
          'familiar: ' + corrections.map((c) => `"${c.right}" (never "${c.wrong}")`).join(', ') + '.'
        : '',
    ].join('');

    const result = await generateStructured({
      capability: def.capability,
      system,
      user: parts.join('\n\n'),
      schema: overrides?.schema ?? outputSchema,
      sink: spent?.text,
    });
    return {
      data: result.data,
      model: result.model,
      promptVersion: prompt.version,
      corrections,
      capability: def.capability,
      usage: ledgerFromTokens(result.usage),
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
        // The chat and the render are different price tiers, so the render is
        // ledgered on its own line. It is registered in `spent` the moment the
        // call returns: if storing the file fails afterwards, the vendor has
        // still charged for the render and the ledger must say so.
        const sink = emptyImageSink();
        const extra: LedgerExtra = { capability: 'image', model: null, usage: {} };
        spent?.extra.push(extra);
        try {
          const image = await generateImage({
            prompt: [pkg.referencePrompts[0], negativeClause(pkg.negativePrompts)]
              .filter(Boolean)
              .join(' '),
            aspectRatio: '1:1',
          }, sink);
          extra.model = image.model;
          extra.usage = ledgerFromImages(sink, 1);

          const key = storageKey(project.id, 'assets', `${slug(asset.name)}-reference.png`);
          await putBlob(key, image.png);
          repo.addAssetReferenceImage(asset.id, key);
          repo.setAssetStatus(asset.id, 'review');
        } catch (error) {
          // Whatever the failed attempt was billed is kept.
          extra.usage = ledgerFromImages(sink, 0);
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
      const outline = requireSingle<OutlineLike>(project.id, 'outline');
      const chapterNumber = Number(job.scopeKey?.replace(/^ch/, '') ?? 0);
      const chapter = outline.chapters?.find((c) => c.number === chapterNumber);
      if (!chapter) {
        throw new BookForgeError('MISSING_INPUT', `Outline has no chapter ${chapterNumber}`, 409);
      }

      // The whole outline was the largest thing the author received, and most
      // of it is beats for other chapters. A chapter needs the spine of the
      // book and its two neighbours in full.
      return reason([
        asUntrustedData('chapter_outline', chapter),
        asUntrustedData('neighbouring_chapters', outlineNeighbours(outline, chapterNumber)),
        asUntrustedData('book_spine', bookSpine(outline)),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('knowledge_map', requireSingle(project.id, 'knowledge_map')),
        // Prose must describe a recurring character the same way every time,
        // so the author keeps the canonical descriptions; background props are
        // the ones it can do without.
        asUntrustedData('asset_registry', registryForProse(readSingle(project.id, 'asset_registry'))),
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
      const critiques = critiquesForChapter(project.id, scope);
      const outline = requireSingle<OutlineLike>(project.id, 'outline');
      const chapterNumber = Number(scope.replace(/^ch/, ''));
      const outcome = await reason([
        asUntrustedData('critiques', critiques),
        asUntrustedData('chapter', currentChapter(project.id, scope) ?? {}),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('chapter_outline', outline.chapters?.find((c) => c.number === chapterNumber) ?? {}),
        asUntrustedData('book_spine', bookSpine(outline)),
      ]);
      // Diagnosis merges critiques; it does not get to raise the stakes above
      // them. On the measured runs it invented critical tasks in rounds where
      // no critic had found one, and the loop ran on those. Enforced here, in
      // the same spirit as the other commit-time rules.
      outcome.data = clampTaskSeverity(outcome.data, critiques);
      return outcome;
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

    case 'editor': {
      // Line editing acts on the prose and the style rules. The knowledge map
      // was six thousand tokens the editor never declared it read.
      const scope = job.scopeKey ?? '';
      return reason([
        asUntrustedData('chapter', currentChapter(project.id, scope) ?? {}),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
      ]);
    }

    case 'copy-editor': {
      // Standardising spelling needs the names, not the map around them.
      const scope = job.scopeKey ?? '';
      return reason([
        asUntrustedData('chapter', currentChapter(project.id, scope) ?? {}),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('canonical_names', canonicalNamesDigest(readSingle(project.id, 'knowledge_map'))),
      ]);
    }

    /* ------------------------ illustration ----------------------- */

    case 'scene-composer': {
      const scope = job.scopeKey ?? '';
      // Choosing moments needs to know which assets exist and how much they
      // matter; the director restates their canon when the prompt is written.
      const maxScenes = env().MAX_SCENES_PER_CHAPTER;
      const outcome = await reason([
        asUntrustedData('chapter', currentChapter(project.id, scope) ?? {}),
        asUntrustedData('asset_registry', assetRegistryDigest(readSingle(project.id, 'asset_registry'))),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        asUntrustedData('chapter_scope', scope),
      // The model is asked for exactly what the cap keeps, so no scene is
      // written and billed only to be discarded.
      ], { system: renderPrompt(prompt.body, { maxScenes: String(maxScenes) }) });
      // Asset names are mapped onto the registry's spellings (a scene that says
      // "Toast" means "Toast (Warhound)") so the reference art is attached, and
      // the chapter keeps its first MAX_SCENES_PER_CHAPTER scenes: each one is
      // a director call, a render and a QA call.
      outcome.data = capScenes(normaliseSceneAssets(outcome.data, registryAssets(project.id)), maxScenes);
      return outcome;
    }

    case 'image-director': {
      const sceneKey = job.scopeKey ?? '';
      const scene = findScene(project.id, sceneKey);
      if (!scene) throw new BookForgeError('MISSING_INPUT', `Scene "${sceneKey}" not found`, 409);

      const packageRows = repo
        .latestArtifactsOfKind<ReferencePackageLike>(project.id, 'reference_package')
        .filter((p) => scene.assets?.some((a) => slug(a) === p.scopeKey));
      const packagedScopes = packageRows.map((p) => p.scopeKey ?? '');

      const outcome = await reason([
        asUntrustedData('scene', scene),
        asUntrustedData('reference_packages', packageRows.map((p) => packageForScenes(p.data))),
        // Assets with no package (background props) still have a canon to state.
        asUntrustedData('asset_canon', canonForUnpackaged(project.id, scene, packagedScopes)),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
      ]);
      // The director's spellings are mapped like the composer's: a near miss
      // would otherwise render with no reference at all.
      const spec = outcome.data as { referenceAssetNames?: unknown };
      if (Array.isArray(spec.referenceAssetNames)) {
        outcome.data = {
          ...spec,
          referenceAssetNames: mapAssetNames(spec.referenceAssetNames, registryAssets(project.id)),
        };
      }
      return outcome;
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
      const wanted = spec.data.referenceAssetNames?.length ? spec.data.referenceAssetNames : (scene?.assets ?? []);
      const references = await referenceImagesFor(project.id, wanted);

      // A regeneration is steered by what QA failed the last render for; it is
      // not the same roll of the dice.
      const verdict = job.round > 0
        ? repo.latestArtifact<{
            criticalFailures?: string[];
            checks?: { check: string; result: string; note?: string }[];
          }>(project.id, 'visual_qa_result', sceneKey)?.data
        : undefined;
      const steering = verdict
        ? [
            ...(verdict.criticalFailures ?? []),
            ...(verdict.checks ?? []).filter((c) => c.result === 'fail').map((c) => c.note || c.check),
          ]
        : [];

      // The job's own tier is image, so its spend accumulates on the job's
      // image sink and survives a failure after the render.
      const sink = spent?.image ?? emptyImageSink();
      const image = await generateImage({
        prompt: [spec.data.prompt, negativeClause([spec.data.negativePrompt, ...steering])]
          .filter(Boolean)
          .join(' '),
        aspectRatio: spec.data.aspectRatio,
        references,
      }, sink);

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
        capability: 'image',
        // One image was delivered however many calls it took; calls are
        // counted separately so a fallback never bills as two images.
        usage: ledgerFromImages(sink, 1, image.referenceCount),
        // A silent fallback is how the canon stopped reaching a render without
        // anyone knowing; it is recorded so Visual QA and the ledger can see it.
        // So is a render that named references and found no sheet for any.
        afterCommit: image.referenceFallback || (wanted.length > 0 && references.length === 0)
          ? () => repo.recordEvent({
              projectId: project.id,
              type: 'ILLUSTRATION_GENERATED',
              actor: 'system',
              payload: {
                sceneKey,
                referenceFallback: image.referenceFallback,
                referencesWanted: wanted.length,
                referencesOffered: references.length,
              },
            })
          : undefined,
      };
    }

    case 'visual-qa': {
      const sceneKey = job.scopeKey ?? '';
      const artwork = repo.latestArtifact<{ storageKey: string; revision: number }>(
        project.id, 'artwork', sceneKey,
      );
      const spec = repo.latestArtifact(project.id, 'image_spec', sceneKey);
      if (!artwork || !spec) {
        throw new BookForgeError('MISSING_INPUT', `No artwork to QA for "${sceneKey}"`, 409);
      }

      const scene = findScene(project.id, sceneKey);
      const packageRows = repo
        .latestArtifactsOfKind<ReferencePackageLike>(project.id, 'reference_package')
        .filter((p) => scene?.assets?.some((a) => slug(a) === p.scopeKey));
      const packagedScopes = packageRows.map((p) => p.scopeKey ?? '');

      // The render first, then the reference sheet it is judged against, named
      // in the context, so identity is compared with the canon and not with
      // its description alone.
      const sheet = await referenceSheetFor(project.id, scene);
      const images = [await getBlob(artwork.data.storageKey), ...(sheet ? [sheet.png] : [])];
      const result = await generateStructured({
        capability: def.capability,
        system: prompt.body,
        user: [
          asUntrustedData('image_spec', spec.data),
          asUntrustedData('scene', scene ?? {}),
          asUntrustedData('reference_packages', packageRows.map((p) => packageForScenes(p.data))),
          asUntrustedData('reference_sheet_for', sheet?.assetName ?? ''),
          asUntrustedData('asset_canon', canonForUnpackaged(project.id, scene, packagedScopes)),
        ].join('\n\n'),
        schema: outputSchema,
        images,
        sink: spent?.text,
      });

      // The render it inspects is billed inside this call's prompt tokens, so
      // it is not also counted as an image input.
      return {
        // The verdict is about the job's scene, whatever key the model echoed,
        // and names the render it judged, so a regeneration is judged afresh
        // rather than inheriting the old render's verdict.
        data: passVerdict({
          ...(result.data as Record<string, unknown>),
          sceneKey,
          artworkRevision: artwork.data.revision,
        }),
        model: result.model,
        promptVersion: prompt.version,
        capability: def.capability,
        usage: ledgerFromTokens(result.usage),
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
      // A chapter's identity is its scope key. The number the model wrote
      // inside the artifact is not trusted to match it, and it is the key the
      // layout's references resolve against.
      const chapters = repo
        .latestArtifactsOfKind<ChapterLike>(project.id, 'clean_manuscript')
        .map((a) => {
          const fromScope = Number(a.scopeKey?.replace(/^ch/, ''));
          return { ...a.data, number: Number.isFinite(fromScope) ? fromScope : a.data.number };
        })
        .sort((a, b) => a.number - b.number);
      const artwork = repo
        .latestArtifactsOfKind<{ sceneKey: string; storageKey: string; width: number; height: number }>(
          project.id, 'artwork',
        )
        .map((a) => a.data);
      const approved = new Set(
        repo
          .latestArtifactsOfKind<{ sceneKey: string; passed: boolean }>(project.id, 'visual_qa_result')
          .filter((q) => q.data.passed)
          .map((q) => q.data.sceneKey),
      );
      // Only QA-approved artwork is offered, each with what it depicts: the
      // prose that used to say so is no longer sent, and a plate has to be
      // placed against the right passage and captioned from something.
      const illustrations = artwork
        .filter((a) => approved.has(a.sceneKey))
        .map((a) => {
          const located = locateScene(project.id, a.sceneKey);
          return {
            sceneKey: a.sceneKey,
            storageKey: a.storageKey,
            width: a.width,
            height: a.height,
            chapterNumber: located?.chapterNumber ?? null,
            action: String(located?.scene.action ?? ''),
            location: String(located?.scene.location ?? ''),
            assets: located?.scene.assets ?? [],
          };
        });

      const outcome = await reason([
        asUntrustedData('brief', requireSingle(project.id, 'brief')),
        asUntrustedData('architecture', requireSingle(project.id, 'architecture')),
        asUntrustedData('design_spec', requireSingle(project.id, 'design_spec')),
        // Layout plans pages from block types and lengths; it never sees the
        // prose, so it cannot retype it.
        asUntrustedData('manuscript_digest', manuscriptDigest(chapters)),
        asUntrustedData('available_illustrations', illustrations),
      ]);
      // The model refers to manuscript blocks; the text is filled in here, byte
      // for byte from the clean manuscript, before the page model is committed.
      const assembled = assemblePageModel(outcome.data, chapters);
      outcome.data = assembled.data;
      if (assembled.relocated > 0) {
        // Prose the layout left out was put back where the manuscript has it;
        // a person may still want to look at where.
        outcome.afterCommit = () => repo.recordEvent({
          projectId: project.id,
          type: 'LAYOUT_REPAIRED',
          actor: 'system',
          payload: { relocatedBlocks: assembled.relocated },
        });
      }
      return outcome;
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
        // Proof's checks are structural; the prose was most of its input.
        asUntrustedData('page_digest', pageDigest(pageModel)),
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
function normaliseArtifact(
  kind: string,
  data: unknown,
  corrections: readonly TermCorrection[] = [],
): unknown {
  // House style is enforced on every artifact, not just prose: headings,
  // captions, blurbs and notes all reach the finished PDF. Canonical spellings
  // are fixed here too: asking the model to honour them does not hold when its
  // own prior prefers a real word to the author's invented one.
  const value = applyCorrectionsDeep(stripEmDashesDeep(data), corrections);

  if (!CHAPTER_KINDS.has(kind) || typeof value !== 'object' || value === null) return value;

  const chapter = value as { blocks?: { text?: string }[]; wordCount?: number };
  if (!Array.isArray(chapter.blocks)) return value;

  const wordCount = chapter.blocks.reduce(
    (total, block) => total + (String(block?.text ?? '').match(/\S+/g)?.length ?? 0),
    0,
  );
  return { ...chapter, wordCount };
}

/**
 * A verdict passes when nothing failed: no critical failure and no check marked
 * `fail`. Derived rather than trusted, so the gate that redoes a render and the
 * gate that publishes the book cannot disagree about it.
 */
function passVerdict(data: Record<string, unknown>): Record<string, unknown> {
  const critical = Array.isArray(data.criticalFailures) ? data.criticalFailures.length : 0;
  const checks = Array.isArray(data.checks) ? (data.checks as { result?: unknown }[]) : [];
  return { ...data, passed: critical === 0 && !checks.some((c) => c?.result === 'fail') };
}

type TaskSeverity = 'critical' | 'major' | 'minor';
const SEVERITY_RANK: Record<TaskSeverity, number> = { critical: 2, major: 1, minor: 0 };

function severityOf(value: unknown): TaskSeverity | null {
  return value === 'critical' || value === 'major' || value === 'minor' ? value : null;
}

/**
 * Highest severity any critic assigned; `minor` when they raised nothing. A
 * critic who rejects the chapter outright has said more than any issue tag,
 * so a `reject` verdict is a critical ceiling on its own.
 */
function maxCritiqueSeverity(critiques: unknown): TaskSeverity {
  let ceiling: TaskSeverity = 'minor';
  for (const critique of Array.isArray(critiques) ? critiques : []) {
    const row = critique as { verdict?: unknown; issues?: unknown } | null;
    if (row?.verdict === 'reject') return 'critical';
    const issues = row?.issues;
    for (const issue of Array.isArray(issues) ? issues : []) {
      const severity = severityOf((issue as { severity?: unknown } | null)?.severity);
      if (severity && SEVERITY_RANK[severity] > SEVERITY_RANK[ceiling]) ceiling = severity;
    }
  }
  return ceiling;
}

/**
 * Cap every revision task at the highest severity the chapter's critiques
 * assigned. A chapter left with nothing at `major` or above needs no rewrite,
 * so a `revise` verdict becomes `pass`, which is the diagnosis prompt's own
 * rule applied deterministically.
 */
function clampTaskSeverity(data: unknown, critiques: unknown): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.tasks)) return data;
  const ceiling = maxCritiqueSeverity(critiques);
  const tasks = record.tasks.map((task) => {
    if (typeof task !== 'object' || task === null) return task;
    const severity = severityOf((task as { severity?: unknown }).severity);
    if (!severity || SEVERITY_RANK[severity] <= SEVERITY_RANK[ceiling]) return task;
    return { ...(task as Record<string, unknown>), severity: ceiling };
  });
  const needsRewrite = tasks.some((task) => {
    const severity = severityOf((task as { severity?: unknown } | null)?.severity);
    return severity !== null && SEVERITY_RANK[severity] >= SEVERITY_RANK.major;
  });
  const clamped: Record<string, unknown> = { ...record, tasks };
  if (record.verdict === 'revise' && !needsRewrite) clamped.verdict = 'pass';
  return clamped;
}

function negativeClause(negatives: (string | undefined)[]): string {
  const items = negatives.filter((n): n is string => Boolean(n && n.trim()));
  return items.length ? `Avoid: ${items.join('; ')}.` : '';
}

/* ----------------------------- driver ------------------------------ */



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

  // An unknown agent name can never succeed. Fail the job rather than throw
  // out of the worker and leave it 'running' with nothing behind it.
  let def: AgentDefinition;
  try {
    def = agentDefinition(job.agent as AgentName);
  } catch (error) {
    repo.failJob(job.id, error instanceof Error ? error.message : String(error), false);
    return;
  }

  const startedAt = Date.now();
  // Every call writes its bill here as it returns, so a throw anywhere after
  // a billed call cannot lose the spend.
  const spent = emptySpent();

  try {
    const outcome = await executeAgent(project, job, spent);

    const artifact = repo.writeArtifact({
      projectId: project.id,
      kind: def.writes,
      scopeKey: outcome.artifactScopeKey !== undefined ? outcome.artifactScopeKey : job.scopeKey,
      data: normaliseArtifact(def.writes, outcome.data, outcome.corrections ?? []),
      producedByJobId: job.id,
    });

    await outcome.afterCommit?.(artifact.id);

    const usage = {
      ...outcome.usage,
      computeSeconds: (Date.now() - startedAt) / 1000,
    };
    // The job row carries the whole bill, other tiers included, so a per-job
    // view does not understate an agent that both chatted and rendered.
    const jobUsage = spent.extra.reduce(
      (total, extra) => addUsage(total, extra.usage),
      addUsage(EMPTY_USAGE, usage),
    );

    repo.completeJob(job.id, {
      outputArtifactIds: [artifact.id],
      model: outcome.model,
      promptVersion: `${def.promptId}@${outcome.promptVersion}`,
      usage: { ...jobUsage },
    });
    repo.recordUsage({
      projectId: project.id,
      jobId: job.id,
      agent: job.agent,
      capability: outcome.capability ?? def.capability,
      model: outcome.model,
      usage,
    });
    for (const extra of spent.extra) {
      if (!hasSpend(extra.usage)) continue;
      repo.recordUsage({
        projectId: project.id,
        jobId: job.id,
        agent: job.agent,
        capability: extra.capability,
        model: extra.model,
        usage: extra.usage,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = isRetryable(error) && job.retryCount < env().AGENT_MAX_RETRIES;
    repo.failJob(job.id, message, retryable);

    // Record exactly what was accumulated before the failure — the chat calls
    // that returned, the render that was billed before storage failed — and
    // nothing that was not. A failure before any call books no spend at all.
    const model = error instanceof BookForgeError
      ? ((error.details.model as string | undefined) ?? null)
      : null;
    const main: Partial<UsageRecord> = {
      ...ledgerFromTokens(spent.text),
      ...(def.capability === 'image' ? ledgerFromImages(spent.image, 0) : {}),
    };
    if (hasSpend(main)) {
      repo.recordUsage({
        projectId: project.id,
        jobId: job.id,
        agent: job.agent,
        capability: def.capability,
        model,
        status: 'failed',
        usage: { ...main, computeSeconds: (Date.now() - startedAt) / 1000 },
      });
    }
    for (const extra of spent.extra) {
      if (!hasSpend(extra.usage)) continue;
      repo.recordUsage({
        projectId: project.id,
        jobId: job.id,
        agent: job.agent,
        capability: extra.capability,
        model: extra.model,
        status: 'failed',
        usage: extra.usage,
      });
    }
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
export const __testing = {
  normaliseArtifact, clampTaskSeverity, passVerdict,
  bookSpine, outlineNeighbours, assetRegistryDigest, registryForProse, canonicalNamesDigest, packageForScenes,
};
