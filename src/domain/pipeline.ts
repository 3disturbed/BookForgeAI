import type { AgentName } from './agents.js';
import type { ApprovalGate } from './states.js';

/** BOOK_PIPELINE.md — the 18 ordered stages. */
export const STAGE_IDS = [
  'discover', 'research', 'map', 'visual_canon', 'architect', 'design',
  'outline', 'author', 'illustrate', 'criticise', 'diagnose', 'rewrite',
  'edit', 'continuity', 'layout', 'proof', 'publish', 'deliver',
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export interface StageDefinition {
  id: StageId;
  /** Ordinal from BOOK_PIPELINE.md, for display. */
  step: number;
  label: string;
  /** Agents run in this stage, in order. */
  agents: readonly AgentName[];
  /** Stages that must be complete before this one starts. */
  dependsOn: readonly StageId[];
  /** Human approval required before the pipeline advances past this stage. */
  gate?: ApprovalGate;
}

export const STAGES: Record<StageId, StageDefinition> = {
  discover: {
    id: 'discover', step: 1, label: 'Discover',
    agents: ['discover'], dependsOn: [], gate: 'brief',
  },
  research: {
    id: 'research', step: 2, label: 'Research',
    agents: ['research'], dependsOn: ['discover'],
  },
  map: {
    id: 'map', step: 3, label: 'Map',
    agents: ['map'], dependsOn: ['research'],
  },
  architect: {
    id: 'architect', step: 5, label: 'Architect',
    agents: ['architect'], dependsOn: ['map'], gate: 'architecture',
  },
  design: {
    id: 'design', step: 6, label: 'Design',
    agents: ['design'], dependsOn: ['architect'],
  },
  visual_canon: {
    id: 'visual_canon', step: 4, label: 'Visual Canon',
    // Canon discovery, then one reference package per discovered asset.
    // SDD.md §4 puts the canon before Architect and Design, so reference art is
    // anchored on the brief's illustration style rather than the design spec.
    agents: ['visual-canon', 'asset-designer'],
    dependsOn: ['map'], gate: 'visual_canon',
  },
  outline: {
    id: 'outline', step: 7, label: 'Outline',
    agents: ['outline'], dependsOn: ['design'], gate: 'outline',
  },
  author: {
    id: 'author', step: 8, label: 'Author',
    agents: ['author'], dependsOn: ['outline'],
  },
  criticise: {
    id: 'criticise', step: 10, label: 'Criticise',
    agents: ['critics'], dependsOn: ['author'],
  },
  diagnose: {
    id: 'diagnose', step: 11, label: 'Diagnose',
    agents: ['diagnosis'], dependsOn: ['criticise'],
  },
  rewrite: {
    id: 'rewrite', step: 12, label: 'Rewrite',
    agents: ['rewriter'], dependsOn: ['diagnose'],
  },
  edit: {
    id: 'edit', step: 13, label: 'Edit',
    agents: ['editor', 'copy-editor'], dependsOn: ['rewrite'], gate: 'manuscript',
  },
  illustrate: {
    id: 'illustrate', step: 9, label: 'Illustrate',
    // BOOK_PIPELINE.md places illustration straight after authoring: scenes are
    // chosen from the draft, which line editing does not move.
    agents: ['scene-composer', 'image-director', 'image-generator', 'visual-qa'],
    dependsOn: ['author', 'visual_canon'], gate: 'key_illustrations',
  },
  continuity: {
    id: 'continuity', step: 14, label: 'Continuity',
    agents: ['continuity'], dependsOn: ['edit'],
  },
  layout: {
    id: 'layout', step: 15, label: 'Layout',
    agents: ['layout'], dependsOn: ['continuity', 'illustrate'],
  },
  proof: {
    id: 'proof', step: 16, label: 'Proof',
    agents: ['proof'], dependsOn: ['layout'], gate: 'final_pdf',
  },
  publish: {
    id: 'publish', step: 17, label: 'Publish',
    agents: [], dependsOn: ['proof'], gate: 'publication_payment',
  },
  deliver: {
    id: 'deliver', step: 18, label: 'Deliver',
    agents: ['publisher'], dependsOn: ['publish'],
  },
};

/** Ordered by BOOK_PIPELINE.md step number, for display. */
export const ORDERED_STAGES: readonly StageDefinition[] = [...STAGE_IDS]
  .map((id) => STAGES[id])
  .sort((a, b) => a.step - b.step);

/**
 * Stages whose dependencies are all satisfied, given what is already complete.
 * The orchestrator uses this to decide what to enqueue next.
 */
export function readyStages(complete: ReadonlySet<StageId>): StageDefinition[] {
  return ORDERED_STAGES.filter(
    (stage) => !complete.has(stage.id) && stage.dependsOn.every((dep) => complete.has(dep)),
  );
}

/** Fails fast on a malformed graph; exercised by the unit tests. */
export function assertAcyclic(): void {
  const seen = new Set<StageId>();
  const stack = new Set<StageId>();

  const visit = (id: StageId): void => {
    if (seen.has(id)) return;
    if (stack.has(id)) throw new Error(`Cycle in pipeline graph at stage "${id}"`);
    stack.add(id);
    for (const dep of STAGES[id].dependsOn) visit(dep);
    stack.delete(id);
    seen.add(id);
  };

  for (const id of STAGE_IDS) visit(id);
}

/** SDD.md §7 — the editorial revision loop. */
export interface RevisionLoopState {
  cycle: number;
  maxCycles: number;
  /** Critical issues still open after the last critique pass. */
  openCriticalIssues: number;
}

export type RevisionDecision = 'rewrite' | 'pass' | 'escalate';

/**
 * CRITICS -> DIAGNOSIS -> REVISION TASKS -> REWRITE -> CRITICS, bounded by
 * MAX_REVISION_CYCLES. Exhausting the budget with issues still open escalates
 * to a human rather than shipping silently.
 */
export function revisionDecision(state: RevisionLoopState): RevisionDecision {
  if (state.openCriticalIssues === 0) return 'pass';
  if (state.cycle >= state.maxCycles) return 'escalate';
  return 'rewrite';
}
