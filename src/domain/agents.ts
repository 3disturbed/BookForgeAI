import type { ArtifactKind } from './artifacts.js';
import type { ModelCapability } from './env.js';

/** AGENTS.md — the 22 pipeline agents. */
export const AGENT_NAMES = [
  'discover', 'research', 'map', 'visual-canon', 'asset-designer',
  'architect', 'design', 'outline', 'author', 'scene-composer',
  'image-director', 'image-generator', 'visual-qa', 'critics', 'diagnosis',
  'rewriter', 'editor', 'copy-editor', 'continuity', 'layout',
  'proof', 'publisher',
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

/**
 * How many jobs one stage expands into.
 * - `single`  one job per project
 * - `chapter` one job per chapter
 * - `asset`   one job per visual asset
 * - `scene`   one job per illustration scene
 */
export type AgentCardinality = 'single' | 'chapter' | 'asset' | 'scene';

export interface AgentDefinition {
  name: AgentName;
  label: string;
  /** Capability requested from the model router — never a concrete model id. */
  capability: ModelCapability;
  cardinality: AgentCardinality;
  reads: readonly ArtifactKind[];
  writes: ArtifactKind;
  /** Prompt id under prompts/, versioned independently of code. */
  promptId: string;
  /**
   * Critics fan out across independent personas (prompts/README.md); each is a
   * separate job so one failing critic cannot silently shrink the critique set.
   */
  personas?: readonly string[];
  /**
   * Best-effort agents produce enrichment, not the book itself. A failure here
   * — most often a model safety refusal on an image — costs the project one
   * illustration, so the stage carries on rather than stalling forever.
   */
  optional?: boolean;
}

/**
 * Per-persona input trimming. Each critic reads only what its lens needs, which
 * removes a large amount of duplicated context from the five calls per chapter.
 */
export const CRITIC_INPUTS: Record<string, readonly ArtifactKind[]> = {
  literary: ['chapter', 'design_spec'],
  structural: ['chapter', 'outline', 'design_spec'],
  audience: ['chapter', 'brief', 'design_spec'],
  factual: ['chapter', 'research_library'],
  continuity: ['chapter', 'knowledge_map', 'outline'],
};

export const CRITIC_PERSONAS = [
  'literary', 'structural', 'audience', 'factual', 'continuity',
] as const;
export type CriticPersona = (typeof CRITIC_PERSONAS)[number];

export const AGENTS: Record<AgentName, AgentDefinition> = {
  discover: {
    name: 'discover', label: 'Discover', capability: 'reasoning', cardinality: 'single',
    reads: [], writes: 'brief', promptId: 'discover',
  },
  research: {
    name: 'research', label: 'Research', capability: 'reasoning', cardinality: 'single',
    reads: ['brief'], writes: 'research_library', promptId: 'research',
  },
  map: {
    name: 'map', label: 'Map', capability: 'reasoning', cardinality: 'single',
    reads: ['brief', 'research_library'], writes: 'knowledge_map', promptId: 'map',
  },
  'visual-canon': {
    name: 'visual-canon', label: 'Visual Canon', capability: 'reasoning', cardinality: 'single',
    reads: ['brief', 'knowledge_map'], writes: 'asset_registry', promptId: 'visual-canon',
  },
  'asset-designer': {
    name: 'asset-designer', label: 'Asset Designer', capability: 'light', cardinality: 'asset',
    reads: ['asset_registry', 'brief'], writes: 'reference_package',
    promptId: 'asset-designer',
    optional: true,
  },
  architect: {
    name: 'architect', label: 'Architect', capability: 'reasoning', cardinality: 'single',
    reads: ['brief', 'knowledge_map'], writes: 'architecture', promptId: 'architect',
  },
  design: {
    name: 'design', label: 'Design', capability: 'reasoning', cardinality: 'single',
    reads: ['brief', 'architecture'], writes: 'design_spec', promptId: 'design',
  },
  outline: {
    name: 'outline', label: 'Outline', capability: 'reasoning', cardinality: 'single',
    reads: ['brief', 'architecture', 'design_spec', 'knowledge_map'],
    writes: 'outline', promptId: 'outline',
  },
  author: {
    name: 'author', label: 'Author', capability: 'text', cardinality: 'chapter',
    reads: ['outline', 'design_spec', 'knowledge_map', 'asset_registry'],
    writes: 'chapter', promptId: 'author',
  },
  'scene-composer': {
    name: 'scene-composer', label: 'Scene Composer', capability: 'light', cardinality: 'chapter',
    reads: ['chapter', 'asset_registry', 'design_spec'], writes: 'scene_spec',
    promptId: 'scene-composer',
  },
  'image-director': {
    name: 'image-director', label: 'Image Director', capability: 'light', cardinality: 'scene',
    reads: ['scene_spec', 'reference_package', 'design_spec'], writes: 'image_spec',
    promptId: 'image-director',
  },
  'image-generator': {
    name: 'image-generator', label: 'Image Generator', capability: 'image', cardinality: 'scene',
    reads: ['image_spec', 'reference_package'], writes: 'artwork',
    promptId: 'image-generator',
    optional: true,
  },
  'visual-qa': {
    name: 'visual-qa', label: 'Visual QA', capability: 'reasoning', cardinality: 'scene',
    reads: ['artwork', 'image_spec', 'reference_package', 'asset_registry'],
    writes: 'visual_qa_result', promptId: 'visual-qa',
    optional: true,
  },
  critics: {
    name: 'critics', label: 'Critics', capability: 'reasoning', cardinality: 'chapter',
    reads: ['chapter', 'outline', 'design_spec', 'knowledge_map'], writes: 'critique',
    promptId: 'critic', personas: CRITIC_PERSONAS,
  },
  diagnosis: {
    name: 'diagnosis', label: 'Diagnosis', capability: 'reasoning', cardinality: 'chapter',
    reads: ['critique', 'chapter', 'outline'], writes: 'revision_tasks',
    promptId: 'diagnosis',
  },
  rewriter: {
    name: 'rewriter', label: 'Rewriter', capability: 'text', cardinality: 'chapter',
    reads: ['revision_tasks', 'chapter', 'design_spec', 'knowledge_map'],
    writes: 'revised_content', promptId: 'rewrite',
  },
  editor: {
    name: 'editor', label: 'Editor', capability: 'text', cardinality: 'chapter',
    reads: ['chapter', 'design_spec'], writes: 'edited_manuscript', promptId: 'editor',
  },
  'copy-editor': {
    name: 'copy-editor', label: 'Copy Editor', capability: 'light', cardinality: 'chapter',
    reads: ['edited_manuscript', 'design_spec', 'knowledge_map'], writes: 'clean_manuscript',
    promptId: 'copy-editor',
  },
  continuity: {
    name: 'continuity', label: 'Continuity', capability: 'reasoning', cardinality: 'single',
    reads: ['clean_manuscript', 'knowledge_map', 'asset_registry'],
    writes: 'continuity_report', promptId: 'continuity',
  },
  layout: {
    name: 'layout', label: 'Layout', capability: 'reasoning', cardinality: 'single',
    reads: ['clean_manuscript', 'design_spec', 'artwork', 'architecture'],
    writes: 'page_model', promptId: 'layout',
  },
  proof: {
    name: 'proof', label: 'Proof', capability: 'reasoning', cardinality: 'single',
    reads: ['page_model'], writes: 'pdf_proof_report', promptId: 'proof',
  },
  publisher: {
    name: 'publisher', label: 'Publisher', capability: 'light', cardinality: 'single',
    reads: ['page_model', 'pdf_proof_report', 'clean_manuscript'], writes: 'edition',
    promptId: 'publisher',
  },
};

export function agentDefinition(name: AgentName): AgentDefinition {
  const def = AGENTS[name];
  if (!def) throw new Error(`Unknown agent: ${name}`);
  return def;
}

export function isAgentName(value: string): value is AgentName {
  return value in AGENTS;
}
