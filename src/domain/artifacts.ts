/**
 * Artifact kinds. Agents READ artifacts and WRITE artifacts (AGENTS.md); state
 * never travels through conversation history.
 */
export const ARTIFACT_KINDS = [
  'brief',
  'research_library',
  'knowledge_map',
  'asset_registry',
  'reference_package',
  'architecture',
  'design_spec',
  'outline',
  'chapter',
  'scene_spec',
  'image_spec',
  'artwork',
  'visual_qa_result',
  'critique',
  'revision_tasks',
  'revised_content',
  'edited_manuscript',
  'clean_manuscript',
  'continuity_report',
  'page_model',
  'pdf_proof_report',
  'edition',
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Artifacts are versioned and immutable once written. An edition pins exact
 * artifact versions so the PDF is reproducible (PDF_PIPELINE.md).
 */
export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  version: number;
}

export interface Artifact<T = unknown> extends ArtifactRef {
  projectId: string;
  /** Scope key for per-chapter / per-asset / per-scene artifacts, else null. */
  scopeKey: string | null;
  data: T;
  /** Job that produced this artifact, for lineage. */
  producedByJobId: string | null;
  createdAt: Date;
}

export function refOf(artifact: Artifact): ArtifactRef {
  return { id: artifact.id, kind: artifact.kind, version: artifact.version };
}
