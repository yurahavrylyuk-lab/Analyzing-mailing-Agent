import { NetworkTargetError } from "./errors";
import { parseStrictAddress } from "./ip-policy";

export const MAX_NETWORK_URL_CHARACTERS = 8192;

const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const explicitSchemePattern = /^([a-z][a-z0-9+.-]*):/iu;
const httpAuthorityPattern = /^https?:\/\//iu;
const asciiHostnamePattern = /^[a-z0-9.-]+$/u;
const hostnameLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const blockedHostnameSuffixes = ["localhost", "local", "internal", "home.arpa"];

function authorityFromAbsoluteUrl(input: string): string {
  const authorityStart = input.indexOf("//") + 2;
  const remainder = input.slice(authorityStart);
  const authorityEnd = remainder.search(/[/?#]/u);
  return authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd);
}

function isBlockedHostname(hostname: string): boolean {
  return blockedHostnameSuffixes.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function validateDnsHostname(hostname: string): void {
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !asciiHostnamePattern.test(hostname)
  ) {
    throw new NetworkTargetError("INVALID_URL");
  }

  const labels = hostname.split(".");
  if (labels.some((label) => !hostnameLabelPattern.test(label))) {
    throw new NetworkTargetError("INVALID_URL");
  }
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function validateRedirectLocationText(input: unknown): string {
  if (typeof input !== "string" || [...input].length > MAX_NETWORK_URL_CHARACTERS) {
    throw new NetworkTargetError("INVALID_URL");
  }

  if (controlCharacterPattern.test(input) || input.includes("\\")) {
    throw new NetworkTargetError("INVALID_URL");
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new NetworkTargetError("INVALID_URL");
  }

  if (trimmed.startsWith("//")) {
    const authority = authorityFromAbsoluteUrl(`http:${trimmed}`);
    if (authority.includes("@")) {
      throw new NetworkTargetError("CREDENTIALS_NOT_ALLOWED");
    }
    if (/\[[^\]]*%/u.test(authority)) {
      throw new NetworkTargetError("INVALID_URL");
    }
  }

  return trimmed;
}

export function normalizeNetworkUrl(input: unknown): string {
  const trimmed = validateRedirectLocationText(input);
  const schemeMatch = explicitSchemePattern.exec(trimmed);
  if (schemeMatch === null) {
    throw new NetworkTargetError("INVALID_URL");
  }

  const scheme = schemeMatch[1]?.toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    throw new NetworkTargetError("UNSUPPORTED_SCHEME");
  }
  if (!httpAuthorityPattern.test(trimmed)) {
    throw new NetworkTargetError("INVALID_URL");
  }

  const authority = authorityFromAbsoluteUrl(trimmed);
  if (authority.includes("@")) {
    throw new NetworkTargetError("CREDENTIALS_NOT_ALLOWED");
  }
  if (/\[[^\]]*%/u.test(authority)) {
    throw new NetworkTargetError("INVALID_URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new NetworkTargetError("INVALID_URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NetworkTargetError("UNSUPPORTED_SCHEME");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new NetworkTargetError("CREDENTIALS_NOT_ALLOWED");
  }
  if (parsed.port.length > 0) {
    throw new NetworkTargetError("PORT_NOT_ALLOWED");
  }

  let hostname = hostnameWithoutBrackets(parsed.hostname).toLowerCase();
  const directAddress = parseStrictAddress(hostname);
  if (directAddress === undefined) {
    if (hostname.endsWith(".")) {
      hostname = hostname.slice(0, -1);
      parsed.hostname = hostname;
    }
    validateDnsHostname(hostname);
    if (isBlockedHostname(hostname)) {
      throw new NetworkTargetError("BLOCKED_HOST");
    }
  } else if (!directAddress.isPublic) {
    throw new NetworkTargetError("BLOCKED_ADDRESS");
  }

  parsed.hash = "";
  return parsed.toString();
}
