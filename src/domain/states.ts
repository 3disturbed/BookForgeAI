import { InvalidTransitionError } from './errors.js';

/** SDD.md §10 — publication state machine. */
export const PUBLICATION_STATES = [
  'DRAFT',
  'READY_FOR_PUBLISH',
  'PAYMENT_REQUIRED',
  'PAID',
  'PUBLISHING',
  'PUBLISHED',
] as const;

export type PublicationState = (typeof PUBLICATION_STATES)[number];

const PUBLICATION_TRANSITIONS: Record<PublicationState, readonly PublicationState[]> = {
  DRAFT: ['READY_FOR_PUBLISH'],
  // Failing acceptance can send a project back to DRAFT (SDD.md §11).
  READY_FOR_PUBLISH: ['PAYMENT_REQUIRED', 'DRAFT'],
  PAYMENT_REQUIRED: ['PAID', 'READY_FOR_PUBLISH'],
  PAID: ['PUBLISHING'],
  PUBLISHING: ['PUBLISHED', 'PAID'],
  // A published edition is immutable; corrections create a new edition.
  PUBLISHED: [],
};

export function canTransition(from: PublicationState, to: PublicationState): boolean {
  return PUBLICATION_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PublicationState, to: PublicationState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** book-project.schema.json — project lifecycle status shown in the UI. */
export const PROJECT_STATUSES = [
  'draft',
  'forging',
  'review',
  'ready_for_publish',
  'payment_required',
  'publishing',
  'published',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** agent-job.schema.json */
export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'blocked'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** visual-asset.schema.json */
export const ASSET_STATUSES = ['draft', 'review', 'locked', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** VISUAL_CANON.md — asset types. */
export const ASSET_TYPES = [
  'character', 'creature', 'animal', 'object', 'vehicle',
  'location', 'building', 'symbol', 'clothing', 'prop',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** SDD.md §6 — default human approval gates. */
export const APPROVAL_GATES = [
  'brief',
  'architecture',
  'visual_canon',
  'outline',
  'manuscript',
  'key_illustrations',
  'final_pdf',
  'publication_payment',
] as const;
export type ApprovalGate = (typeof APPROVAL_GATES)[number];
