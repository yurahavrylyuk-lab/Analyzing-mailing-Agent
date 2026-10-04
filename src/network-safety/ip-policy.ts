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
  return Object.freeze({
    address: parsed.toString(),
    family,
    isPublic: parsed.range() === "unicast",
  });
}
