export class InvalidSuppressionInputError extends Error {
  readonly name = "InvalidSuppressionInputError";

  constructor() {
    super("Do-not-contact suppression input is invalid.");
  }
}

export type ContactBlockedReason = "suppressed" | "archived";

export class ContactBlockedError extends Error {
  readonly name = "ContactBlockedError";

  constructor(readonly reason: ContactBlockedReason) {
    super("Contact is blocked by the current lead state.");
  }
}

export class ContactProtectionUnavailableError extends Error {
  readonly name = "ContactProtectionUnavailableError";

  constructor() {
    super("Contact protection is unavailable.");
  }
}
