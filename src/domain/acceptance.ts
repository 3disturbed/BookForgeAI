/** SDD.md §11 — publish acceptance criteria. */
export interface AcceptanceInput {
  hasRequiredContent: boolean;
  unresolvedCriticalIssues: number;
  requiredArtworkPresent: boolean;
  visualQaPassed: boolean;
  continuityPassed: boolean;
  pdfRendered: boolean;
  proofPassed: boolean;
  userApprovedFinalEdition: boolean;
  paymentConfirmed: boolean;
}

export interface AcceptanceCheck {
  criterion: string;
  passed: boolean;
  /** Blocking criteria must pass before the project can reach PUBLISHING. */
  blocking: boolean;
}

export interface AcceptanceResult {
  accepted: boolean;
  checks: AcceptanceCheck[];
  blockers: string[];
}

export function evaluateAcceptance(input: AcceptanceInput): AcceptanceResult {
  const checks: AcceptanceCheck[] = [
    { criterion: 'Required content exists', passed: input.hasRequiredContent, blocking: true },
    {
      criterion: 'No unresolved critical editorial issues',
      passed: input.unresolvedCriticalIssues === 0,
      blocking: true,
    },
    { criterion: 'Required artwork exists', passed: input.requiredArtworkPresent, blocking: true },
    { criterion: 'Artwork passes visual QA', passed: input.visualQaPassed, blocking: true },
    { criterion: 'Continuity QA passes', passed: input.continuityPassed, blocking: true },
    { criterion: 'PDF renders', passed: input.pdfRendered, blocking: true },
    { criterion: 'Proof passes', passed: input.proofPassed, blocking: true },
    {
      criterion: 'User approves final edition',
      passed: input.userApprovedFinalEdition,
      blocking: true,
    },
    { criterion: 'Payment confirmed', passed: input.paymentConfirmed, blocking: true },
  ];

  const blockers = checks.filter((c) => c.blocking && !c.passed).map((c) => c.criterion);
  return { accepted: blockers.length === 0, checks, blockers };
}
