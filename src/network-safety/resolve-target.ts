import type { DnsAddressRecord, DnsResolver } from "./dns-resolver";
import { NetworkTargetError } from "./errors";
import { parseStrictAddress } from "./ip-policy";
import {
  normalizeNetworkUrl,
  validateRedirectLocationText,
} from "./network-url";

export type SafeNetworkTarget = Readonly<{
  url: string;
  hostname: string;
  port: 80 | 443;
  addresses: readonly DnsAddressRecord[];
}>;

function plainHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function validatedRecord(record: unknown): DnsAddressRecord {
  if (
    typeof record !== "object" ||
    record === null ||
    !("address" in record) ||
    !("family" in record) ||
    typeof record.address !== "string" ||
    (record.family !== 4 && record.family !== 6)
  ) {
    throw new NetworkTargetError("DNS_RESOLUTION_FAILED");
  }

  const parsed = parseStrictAddress(record.address);
  if (parsed === undefined || parsed.family !== record.family) {
    throw new NetworkTargetError("DNS_RESOLUTION_FAILED");
  }
  if (!parsed.isPublic) {
    throw new NetworkTargetError("BLOCKED_ADDRESS");
  }

  return Object.freeze({ address: parsed.address, family: parsed.family });
}

function immutableTarget(
  normalizedUrl: string,
  hostname: string,
  port: 80 | 443,
  addresses: readonly DnsAddressRecord[],
): SafeNetworkTarget {
  return Object.freeze({
    url: normalizedUrl,
    hostname,
    port,
    addresses: Object.freeze([...addresses]),
  });
}

export async function resolveSafeTarget(
  input: unknown,
  resolver: DnsResolver,
): Promise<SafeNetworkTarget> {
  const normalizedUrl = normalizeNetworkUrl(input);
  const parsedUrl = new URL(normalizedUrl);
  const hostname = plainHostname(parsedUrl);
  const port = parsedUrl.protocol === "http:" ? 80 : 443;
  const directAddress = parseStrictAddress(hostname);

  if (directAddress !== undefined) {
    if (!directAddress.isPublic) {
      throw new NetworkTargetError("BLOCKED_ADDRESS");
    }
    return immutableTarget(normalizedUrl, hostname, port, [
      Object.freeze({ address: directAddress.address, family: directAddress.family }),
    ]);
  }

  let records: readonly DnsAddressRecord[];
  try {
    records = await resolver.resolve(hostname);
  } catch {
    throw new NetworkTargetError("DNS_RESOLUTION_FAILED");
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new NetworkTargetError("DNS_RESOLUTION_FAILED");
  }

  const unique = new Map<string, DnsAddressRecord>();
  for (const record of records as readonly unknown[]) {
    const validated = validatedRecord(record);
    unique.set(`${validated.family}:${validated.address}`, validated);
  }

  return immutableTarget(normalizedUrl, hostname, port, [...unique.values()]);
}

export async function resolveSafeRedirect(
  previousTarget: SafeNetworkTarget,
  location: unknown,
  resolver: DnsResolver,
): Promise<SafeNetworkTarget> {
  const validatedLocation = validateRedirectLocationText(location);
  const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:/iu.test(validatedLocation);
  let candidate: string;

  if (hasExplicitScheme) {
    candidate = validatedLocation;
  } else {
    try {
      candidate = new URL(validatedLocation, previousTarget.url).toString();
    } catch {
      throw new NetworkTargetError("INVALID_URL");
    }
  }

  return resolveSafeTarget(candidate, resolver);
}
