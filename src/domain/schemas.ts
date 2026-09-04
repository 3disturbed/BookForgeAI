import { z } from 'zod';
import { ARTIFACT_KINDS, type ArtifactKind } from './artifacts.js';
import { ASSET_STATUSES, ASSET_TYPES, JOB_STATUSES, PROJECT_STATUSES } from './states.js';

/* ------------------------------------------------------------------ *
 * Published contracts — mirror of the JSON Schemas in schemas/.
 * ------------------------------------------------------------------ */

export const VisualAssetSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(ASSET_TYPES),
  status: z.enum(ASSET_STATUSES),
  canonicalDescription: z.record(z.string(), z.unknown()),
  referenceImageIds: z.array(z.string()).default([]),
  version: z.number().int().min(1).default(1),
});
export type VisualAsset = z.infer<typeof VisualAssetSchema>;

export const AgentJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  agent: z.string(),
  status: z.enum(JOB_STATUSES),
  inputArtifactIds: z.array(z.string()),
  outputArtifactIds: z.array(z.string()).default([]),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  retryCount: z.number().int().min(0).default(0),
  usage: z.record(z.string(), z.unknown()).default({}),
});
export type AgentJobRecord = z.infer<typeof AgentJobSchema>;

export const BookProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(PROJECT_STATUSES),
  genre: z.string(),
  brief: z.record(z.string(), z.unknown()),
  research: z.array(z.record(z.string(), z.unknown())).default([]),
  knowledgeMap: z.record(z.string(), z.unknown()).optional(),
  architecture: z.record(z.string(), z.unknown()).optional(),
  design: z.record(z.string(), z.unknown()),
  outline: z.record(z.string(), z.unknown()).optional(),
  visualAssets: z.array(z.string()).default([]),
  chapters: z.array(z.string()).default([]),
  illustrations: z.array(z.string()).default([]),
  editionId: z.string().nullable().default(null),
});
export type BookProject = z.infer<typeof BookProjectSchema>;

/* ------------------------------------------------------------------ *
 * Agent output contracts. Every agent's output is parsed with one of
 * these before it is committed as an artifact (SDD.md §9).
 * ------------------------------------------------------------------ */

export const BriefSchema = z.object({
  title: z.string().min(1),
  premise: z.string().min(1),
  genre: z.string().min(1),
  audience: z.string().min(1),
  toneKeywords: z.array(z.string()).min(1),
  themes: z.array(z.string()).default([]),
  targetWordCount: z.number().int().positive(),
  targetChapterCount: z.number().int().positive(),
  illustrationStyle: z.string().min(1),
  openQuestions: z.array(z.string()).default([]),
});

/**
 * The author's answers to questions the agents raised. Every later agent reads
 * this, so a decision made once is honoured everywhere instead of each agent
 * quietly inventing its own.
 */
export const DecisionsSchema = z.object({
  answers: z.array(
    z.object({
      question: z.string().min(1),
      /** Empty when the author explicitly delegated the choice. */
      answer: z.string().default(''),
      /** True when the author read the question and handed it back. */
      delegated: z.boolean().default(false),
      answeredAt: z.string().default(''),
    }),
  ).default([]),
});

export const ResearchSourceSchema = z.object({
  title: z.string(),
  kind: z.enum(['fact', 'reference', 'inspiration', 'constraint']),
  summary: z.string(),
  claims: z.array(z.string()).default([]),
  /** Model-supplied provenance; unverified until a human or tool checks it. */
  citation: z.string().default(''),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
});

export const ResearchLibrarySchema = z.object({
  sources: z.array(ResearchSourceSchema),
  gaps: z.array(z.string()).default([]),
});

export const KnowledgeMapSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      description: z.string(),
      aliases: z.array(z.string()).default([]),
    }),
  ),
  relationships: z
    .array(z.object({ from: z.string(), to: z.string(), relation: z.string() }))
    .default([]),
  timeline: z
    .array(z.object({ label: z.string(), when: z.string(), summary: z.string() }))
    .default([]),
  locations: z.array(z.object({ name: z.string(), description: z.string() })).default([]),
});

export const AssetRegistrySchema = z.object({
  assets: z.array(
    z.object({
      name: z.string().min(1),
      type: z.enum(ASSET_TYPES),
      importance: z.enum(['primary', 'secondary', 'background']),
      firstAppearance: z.string().default(''),
      canonicalDescription: z.record(z.string(), z.unknown()),
    }),
  ),
});

/** VISUAL_CANON.md — Character Bible / Item Bible fields. */
export const ReferencePackageSchema = z.object({
  assetName: z.string(),
  bible: z.object({
    identity: z.string().default(''),
    ageOrScale: z.string().default(''),
    species: z.string().default(''),
    proportions: z.string().default(''),
    face: z.string().default(''),
    hairFurScales: z.string().default(''),
    eyes: z.string().default(''),
    clothing: z.string().default(''),
    accessories: z.string().default(''),
    distinguishingMarks: z.string().default(''),
    material: z.string().default(''),
    markings: z.string().default(''),
    damage: z.string().default(''),
    uniqueFeatures: z.string().default(''),
    palette: z.array(z.string()).default([]),
    personality: z.string().default(''),
    style: z.string().default(''),
  }),
  /** Prompt used to render the canonical reference sheet. */
  referencePrompts: z.array(z.string()).min(1),
  negativePrompts: z.array(z.string()).default([]),
});

export const ArchitectureSchema = z.object({
  structure: z.string(),
  parts: z
    .array(
      z.object({
        title: z.string(),
        purpose: z.string(),
        chapterRange: z.string().default(''),
      }),
    )
    .default([]),
  chapterCount: z.number().int().positive(),
  narrativeArc: z.string().default(''),
  pacingNotes: z.string().default(''),
});

export const DesignSpecSchema = z.object({
  voice: z.string(),
  tone: z.string(),
  pov: z.string().default(''),
  tense: z.string().default(''),
  pacing: z.string().default(''),
  visualLanguage: z.string(),
  paletteNotes: z.string().default(''),
  typographyNotes: z.string().default(''),
  template: z.enum(['novel', 'illustrated_story', 'non_fiction']),
  styleRules: z.array(z.string()).default([]),
});

export const OutlineSchema = z.object({
  chapters: z
    .array(
      z.object({
        number: z.number().int().positive(),
        title: z.string(),
        summary: z.string(),
        beats: z.array(z.string()).default([]),
        targetWordCount: z.number().int().positive(),
        entities: z.array(z.string()).default([]),
        illustrationHints: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});

/** Chapter body is structured blocks, not raw markdown (PDF_PIPELINE.md). */
export const ChapterSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  blocks: z
    .array(
      z.object({
        type: z.enum(['paragraph', 'heading', 'dialogue', 'quote', 'break', 'list']),
        text: z.string(),
        level: z.number().int().min(1).max(6).optional(),
      }),
    )
    .min(1),
  wordCount: z.number().int().min(0).default(0),
  notes: z.array(z.string()).default([]),
});

export const SceneSpecSchema = z.object({
  scenes: z.array(
    z.object({
      key: z.string(),
      chapterNumber: z.number().int().positive(),
      assets: z.array(z.string()).default([]),
      location: z.string().default(''),
      time: z.string().default(''),
      weather: z.string().default(''),
      action: z.string(),
      emotion: z.string().default(''),
      camera: z.string().default(''),
      composition: z.string().default(''),
      lighting: z.string().default(''),
      style: z.string().default(''),
      requiredReferences: z.array(z.string()).default([]),
    }),
  ),
});

export const ImageSpecSchema = z.object({
  sceneKey: z.string(),
  prompt: z.string().min(1),
  negativePrompt: z.string().default(''),
  aspectRatio: z.enum(['1:1', '3:2', '2:3', '16:9', '4:5']).default('2:3'),
  referenceAssetNames: z.array(z.string()).default([]),
  /** Checks Visual QA runs against the render (VISUAL_CANON.md). */
  qaChecklist: z.array(z.string()).min(1),
});

export const ArtworkSchema = z.object({
  sceneKey: z.string(),
  storageKey: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: z.string().default('image/png'),
  model: z.string(),
  revision: z.number().int().min(1).default(1),
});

export const VisualQaResultSchema = z.object({
  sceneKey: z.string(),
  passed: z.boolean(),
  checks: z.array(
    z.object({
      check: z.string(),
      result: z.enum(['pass', 'warn', 'fail']),
      note: z.string().default(''),
    }),
  ),
  criticalFailures: z.array(z.string()).default([]),
  /** Critical failures trigger rejection and regeneration. */
  recommendation: z.enum(['accept', 'regenerate', 'escalate']),
});

export const CritiqueSchema = z.object({
  persona: z.string(),
  chapterNumber: z.number().int().positive(),
  verdict: z.enum(['pass', 'revise', 'reject']),
  issues: z
    .array(
      z.object({
        severity: z.enum(['critical', 'major', 'minor']),
        area: z.string(),
        description: z.string(),
        evidence: z.string().default(''),
      }),
    )
    .default([]),
  strengths: z.array(z.string()).default([]),
});

export const RevisionTasksSchema = z.object({
  chapterNumber: z.number().int().positive(),
  tasks: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['critical', 'major', 'minor']),
      instruction: z.string(),
      rationale: z.string().default(''),
      sourceCritiques: z.array(z.string()).default([]),
    }),
  ),
  /** Diagnosis may conclude the chapter is already acceptable. */
  verdict: z.enum(['revise', 'pass']),
});

export const ContinuityReportSchema = z.object({
  passed: z.boolean(),
  findings: z
    .array(
      z.object({
        severity: z.enum(['critical', 'major', 'minor']),
        kind: z.string(),
        description: z.string(),
        chapters: z.array(z.number().int()).default([]),
      }),
    )
    .default([]),
});

/** PDF_PIPELINE.md — the structured page model the renderer consumes. */
export const PageModelSchema = z.object({
  template: z.enum(['novel', 'illustrated_story', 'non_fiction']),
  pageSize: z.enum(['a4', 'letter', 'digest']).default('digest'),
  margins: z.object({
    top: z.number(),
    bottom: z.number(),
    inner: z.number(),
    outer: z.number(),
  }),
  pages: z
    .array(
      z.object({
        index: z.number().int().min(1),
        kind: z.enum(['cover', 'front_matter', 'body', 'plate', 'back_matter', 'blank']),
        blocks: z
          .array(
            z.object({
              type: z.enum([
                'heading', 'text', 'image', 'caption',
                'page_number', 'decoration', 'table', 'footnote',
              ]),
              text: z.string().default(''),
              level: z.number().int().min(1).max(6).optional(),
              storageKey: z.string().optional(),
              rows: z.array(z.array(z.string())).optional(),
            }),
          )
          .default([]),
      }),
    )
    .min(1),
});

export const PdfProofReportSchema = z.object({
  passed: z.boolean(),
  pageCount: z.number().int().min(1),
  checks: z.array(
    z.object({
      check: z.string(),
      result: z.enum(['pass', 'warn', 'fail']),
      note: z.string().default(''),
    }),
  ),
});

export const EditionSchema = z.object({
  editionNumber: z.number().int().min(1),
  title: z.string(),
  isbn: z.string().default(''),
  blurb: z.string().default(''),
  /** Frozen artifact versions make the edition reproducible. */
  frozenArtifactIds: z.array(z.string()).default([]),
  pdfStorageKey: z.string().default(''),
});

/* ------------------------------------------------------------------ *
 * Kind -> schema table used by the validation gate.
 * ------------------------------------------------------------------ */

export const ARTIFACT_SCHEMAS = {
  brief: BriefSchema,
  decisions: DecisionsSchema,
  research_library: ResearchLibrarySchema,
  knowledge_map: KnowledgeMapSchema,
  asset_registry: AssetRegistrySchema,
  reference_package: ReferencePackageSchema,
  architecture: ArchitectureSchema,
  design_spec: DesignSpecSchema,
  outline: OutlineSchema,
  chapter: ChapterSchema,
  scene_spec: SceneSpecSchema,
  image_spec: ImageSpecSchema,
  artwork: ArtworkSchema,
  visual_qa_result: VisualQaResultSchema,
  critique: CritiqueSchema,
  revision_tasks: RevisionTasksSchema,
  revised_content: ChapterSchema,
  edited_manuscript: ChapterSchema,
  clean_manuscript: ChapterSchema,
  continuity_report: ContinuityReportSchema,
  page_model: PageModelSchema,
  pdf_proof_report: PdfProofReportSchema,
  edition: EditionSchema,
} as const satisfies Record<ArtifactKind, z.ZodTypeAny>;

export type ArtifactData<K extends ArtifactKind> = z.infer<(typeof ARTIFACT_SCHEMAS)[K]>;

export function schemaFor<K extends ArtifactKind>(kind: K): (typeof ARTIFACT_SCHEMAS)[K] {
  return ARTIFACT_SCHEMAS[kind];
}

/** Every declared artifact kind has a schema; asserted by the unit tests. */
export function assertSchemaCoverage(): void {
  const missing = ARTIFACT_KINDS.filter((k) => !(k in ARTIFACT_SCHEMAS));
  if (missing.length) throw new Error(`Artifact kinds without a schema: ${missing.join(', ')}`);
}
