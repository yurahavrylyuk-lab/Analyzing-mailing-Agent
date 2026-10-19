export class InvalidDiscoveryCriteriaError extends Error {
  readonly name = "InvalidDiscoveryCriteriaError";

  constructor() {
    super("Discovery criteria are invalid.");
  }
}

export const DISCOVERY_PROVIDER_ERROR_MESSAGES = {
  INVALID_REQUEST: "Discovery provider request is invalid.",
  UNSUPPORTED_QUERY: "Discovery query is not supported.",
  INVALID_CURSOR: "Discovery cursor is invalid.",
  LOCATION_NOT_FOUND: "Discovery location was not found.",
  LOCATION_AMBIGUOUS: "Discovery location is ambiguous.",
  UNSUPPORTED_LOCATION: "Discovery location is not supported.",
  ACCESS_DENIED: "Discovery provider access was denied.",
  RATE_LIMITED: "Discovery provider rate limit was reached.",
  REQUEST_REJECTED: "Discovery provider rejected the request.",
  PROVIDER_UNAVAILABLE: "Discovery provider is unavailable.",
  TIMEOUT: "Discovery provider request timed out.",
  CANCELLED: "Discovery provider request was cancelled.",
  REDIRECT_REFUSED: "Discovery provider redirect was refused.",
  NETWORK_FAILURE: "Discovery provider network request failed.",
  RESPONSE_TOO_LARGE: "Discovery provider response is too large.",
  UNEXPECTED_STATUS: "Discovery provider returned an unexpected status.",
} as const;

export type DiscoveryProviderErrorCode = keyof typeof DISCOVERY_PROVIDER_ERROR_MESSAGES;

export class DiscoveryProviderError extends Error {
  readonly name = "DiscoveryProviderError";
  readonly code: DiscoveryProviderErrorCode;

  constructor(code: DiscoveryProviderErrorCode) {
    super(DISCOVERY_PROVIDER_ERROR_MESSAGES[code]);
    this.code = code;
  }
}

export type MalformedDiscoveryResponseErrorCode =
  | "INVALID_ENVELOPE"
  | "INVALID_JSON"
  | "INVALID_CONTENT_TYPE";

export class MalformedDiscoveryResponseError extends Error {
  readonly name = "MalformedDiscoveryResponseError";
  declare readonly code?: MalformedDiscoveryResponseErrorCode;

  constructor(code?: MalformedDiscoveryResponseErrorCode) {
    super("Discovery provider response is invalid.");
    if (code !== undefined) {
      Object.defineProperty(this, "code", {
        configurable: false,
        enumerable: true,
        value: code,
        writable: false,
      });
    }
  }
}
