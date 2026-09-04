/** ARCHITECTURE.md — core domain events. */
export const CORE_EVENTS = [
  'PROJECT_CREATED',
  'BRIEF_CREATED',
  'RESEARCH_COMPLETE',
  'MAP_COMPLETE',
  'VISUAL_CANON_CREATED',
  'VISUAL_ASSET_APPROVED',
  'ARCHITECTURE_APPROVED',
  'OUTLINE_APPROVED',
  'CHAPTER_DRAFTED',
  'ILLUSTRATION_GENERATED',
  'ILLUSTRATION_APPROVED',
  'CRITIQUE_COMPLETE',
  'REVISION_REQUIRED',
  'REVISION_COMPLETE',
  'MANUSCRIPT_APPROVED',
  'PDF_RENDERED',
  'PDF_PROOFED',
  'PAYMENT_CONFIRMED',
  'PUBLICATION_STARTED',
  'PUBLICATION_COMPLETE',
] as const;

export type CoreEvent = (typeof CORE_EVENTS)[number];

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  type: CoreEvent;
  projectId: string;
  /** A user id, or `system` for orchestrator-emitted events. */
  actor: string;
  payload: T;
  occurredAt: Date;
}
