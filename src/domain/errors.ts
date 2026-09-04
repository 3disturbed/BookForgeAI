/** Base class for errors carrying a stable machine-readable code. */
export class BookForgeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 500,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Agent output failed schema validation. Never committed as an artifact. */
export class ArtifactValidationError extends BookForgeError {
  constructor(agent: string, issues: unknown) {
    super(
      'ARTIFACT_INVALID',
      `Agent "${agent}" produced output that failed schema validation`,
      422,
      { agent, issues },
    );
  }
}

/** A gate, dependency or state precondition was not satisfied. */
export class PreconditionError extends BookForgeError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PRECONDITION_FAILED', message, 409, details);
  }
}

/** The requested transition is not legal for the current state. */
export class InvalidTransitionError extends BookForgeError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSITION', `Illegal transition ${from} -> ${to}`, 409, { from, to });
  }
}

/** SECURITY.md: scope all queries to authenticated project ownership. */
export class NotAuthorizedError extends BookForgeError {
  constructor(resource: string) {
    super('NOT_AUTHORIZED', `Not authorized for ${resource}`, 403, { resource });
  }
}

export class NotFoundError extends BookForgeError {
  constructor(resource: string) {
    super('NOT_FOUND', `${resource} not found`, 404, { resource });
  }
}

export class BadRequestError extends BookForgeError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('BAD_REQUEST', message, 400, details);
  }
}
