import { resolve4, resolve6 } from "node:dns/promises";

import { NetworkTargetError } from "./errors";
import type { AddressFamily } from "./ip-policy";

export type DnsAddressRecord = Readonly<{
  address: string;
  family: AddressFamily;
}>;

export interface DnsResolver {
  resolve(hostname: string): Promise<readonly DnsAddressRecord[]>;
}

const DNS_TIMEOUT_MILLISECONDS = 3000;

function isNoDataError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENODATA"
  );
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new NetworkTargetError("DNS_RESOLUTION_FAILED")),
      DNS_TIMEOUT_MILLISECONDS,
    );
  });

  try {
    return await Promise.race([operation, expired]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function resolveFamily(
  hostname: string,
  family: AddressFamily,
): Promise<readonly DnsAddressRecord[]> {
  try {
    const addresses = await withTimeout(
      family === 4 ? resolve4(hostname) : resolve6(hostname),
    );
    return addresses.map((address) => Object.freeze({ address, family }));
  } catch (error) {
    if (isNoDataError(error)) {
      return [];
    }
    if (error instanceof NetworkTargetError) {
      throw error;
    }
    throw new NetworkTargetError("DNS_RESOLUTION_FAILED");
  }
}

export function createNodeDnsResolver(): DnsResolver {
  return Object.freeze({
    async resolve(hostname: string): Promise<readonly DnsAddressRecord[]> {
      try {
        const [ipv4, ipv6] = await Promise.all([
          resolveFamily(hostname, 4),
          resolveFamily(hostname, 6),
        ]);
        return Object.freeze([...ipv4, ...ipv6]);
      } catch {
        throw new NetworkTargetError("DNS_RESOLUTION_FAILED");
      }
    },
  });
}
