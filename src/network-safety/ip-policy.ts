import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

export type AddressFamily = 4 | 6;

export type ValidatedAddress = Readonly<{
  address: string;
  family: AddressFamily;
  isPublic: boolean;
}>;

export function parseStrictAddress(value: string): ValidatedAddress | undefined {
  if (typeof value !== "string" || value.includes("%")) {
    return undefined;
  }

  const family = isIP(value);
  if (family !== 4 && family !== 6) {
    return undefined;
  }

  const parsed = ipaddr.parse(value);
  let matchesOmittedNonPublicPrefix = false;
  if (parsed.kind() === "ipv6") {
    for (const prefix of [
      "fec0::/10",
      "3fff::/20",
      "64:ff9b:1::/48",
      "100:0:0:1::/64",
    ] as const) {
      const [network, bits] = ipaddr.parseCIDR(prefix);
      if (parsed.match(network, bits)) {
        matchesOmittedNonPublicPrefix = true;
        break;
      }
    }
  }

  return Object.freeze({
    address: parsed.toString(),
    family,
    isPublic: parsed.range() === "unicast" && !matchesOmittedNonPublicPrefix,
  });
}
