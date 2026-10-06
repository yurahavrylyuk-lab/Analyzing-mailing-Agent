export class InvalidDiscoveryCriteriaError extends Error {
  readonly name = "InvalidDiscoveryCriteriaError";

  constructor() {
    super("Discovery criteria are invalid.");
  }
}

export class MalformedDiscoveryResponseError extends Error {
  readonly name = "MalformedDiscoveryResponseError";

  constructor() {
    super("Discovery provider response is invalid.");
  }
}
