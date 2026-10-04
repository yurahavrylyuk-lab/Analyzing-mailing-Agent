export class InvalidAuditActorError extends Error {
  readonly name = "InvalidAuditActorError";

  constructor() {
    super("Audit actor is invalid.");
  }
}

export class InvalidAuditEventError extends Error {
  readonly name = "InvalidAuditEventError";

  constructor() {
    super("Audit event is invalid or contains unsupported details.");
  }
}

export class OversizedAuditDetailsError extends Error {
  readonly name = "OversizedAuditDetailsError";

  constructor() {
    super("Audit event details exceed the maximum size.");
  }
}
