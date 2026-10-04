export const NETWORK_TARGET_ERROR_CODES = [
  "INVALID_URL",
  "UNSUPPORTED_SCHEME",
  "CREDENTIALS_NOT_ALLOWED",
  "PORT_NOT_ALLOWED",
  "BLOCKED_HOST",
  "BLOCKED_ADDRESS",
  "DNS_RESOLUTION_FAILED",
] as const;

export type NetworkTargetErrorCode = (typeof NETWORK_TARGET_ERROR_CODES)[number];

const messages: Readonly<Record<NetworkTargetErrorCode, string>> = {
  INVALID_URL: "Network URL is invalid.",
  UNSUPPORTED_SCHEME: "Network URL scheme is not supported.",
  CREDENTIALS_NOT_ALLOWED: "Network URL credentials are not allowed.",
  PORT_NOT_ALLOWED: "Network URL port is not allowed.",
  BLOCKED_HOST: "Network hostname is not allowed.",
  BLOCKED_ADDRESS: "Network address is not allowed.",
  DNS_RESOLUTION_FAILED: "Network hostname resolution failed.",
};

export class NetworkTargetError extends Error {
  readonly name = "NetworkTargetError";

  constructor(readonly code: NetworkTargetErrorCode) {
    super(messages[code]);
  }
}
