export class InvalidLeadInputError extends Error {
  readonly name = "InvalidLeadInputError";
}

export class InvalidDiscoveredLeadInputError extends Error {
  readonly name = "InvalidDiscoveredLeadInputError";

  constructor() {
    super("Discovered lead input is invalid.");
  }
}

export class LeadPersistenceError extends Error {
  readonly name = "LeadPersistenceError";

  constructor() {
    super("Lead persistence operation failed.");
  }
}

export class LeadNotFoundError extends Error {
  readonly name = "LeadNotFoundError";

  constructor() {
    super("Business lead was not found.");
  }
}

export class InvalidLeadTransitionError extends Error {
  readonly name = "InvalidLeadTransitionError";

  constructor(from: string, to: string) {
    super(`Business lead cannot transition from ${from} to ${to}.`);
  }
}

export class StaleLeadVersionError extends Error {
  readonly name = "StaleLeadVersionError";

  constructor() {
    super("Business lead was changed by another operation.");
  }
}

export class ArchivedLeadWebsiteMutationError extends Error {
  readonly name = "ArchivedLeadWebsiteMutationError";

  constructor() {
    super("Website observations cannot be changed for an archived business lead.");
  }
}
