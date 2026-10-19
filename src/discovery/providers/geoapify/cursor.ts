import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { DiscoveryCriteria } from "../../domain";
import { DiscoveryProviderError } from "../../errors";

export const MAX_GEOAPIFY_CURSOR_CHARACTERS = 2_048;

const AREA_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

type CursorPayload = Readonly<{
  version: 1;
  areaId: string;
  nextOffset: number;
  criteriaDigest: string;
}>;

export type GeoapifyCursorValue = Readonly<{
  areaId: string;
  offset: number;
}>;

export type GeoapifyCursorCodec = Readonly<{
  encode(areaId: string, nextOffset: number, criteria: DiscoveryCriteria): string;
  decode(cursor: string, criteria: DiscoveryCriteria): GeoapifyCursorValue;
}>;

function invalidCursor(): DiscoveryProviderError {
  return new DiscoveryProviderError("INVALID_CURSOR");
}

function criteriaDigest(criteria: DiscoveryCriteria): string {
  return createHash("sha256")
    .update(JSON.stringify([criteria.location, criteria.query, criteria.maxResults]), "utf8")
    .digest("hex");
}

function isValidAreaId(value: unknown): value is string {
  return typeof value === "string" && AREA_ID_PATTERN.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isExactPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 4 &&
    keys[0] === "areaId" &&
    keys[1] === "criteriaDigest" &&
    keys[2] === "nextOffset" &&
    keys[3] === "version" &&
    record.version === 1 &&
    isValidAreaId(record.areaId) &&
    isPositiveSafeInteger(record.nextOffset) &&
    typeof record.criteriaDigest === "string" &&
    SHA256_HEX_PATTERN.test(record.criteriaDigest)
  );
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throw invalidCursor();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw invalidCursor();
  }
  return decoded;
}

export function createGeoapifyCursorCodec(signingKey: Uint8Array): GeoapifyCursorCodec {
  if (!(signingKey instanceof Uint8Array) || signingKey.byteLength !== 32) {
    throw new TypeError("Geoapify cursor signing key must contain exactly 32 bytes.");
  }
  const key = Buffer.from(signingKey);

  function signature(encodedPayload: string): Buffer {
    return createHmac("sha256", key).update(encodedPayload, "ascii").digest();
  }

  return Object.freeze({
    encode(areaId: string, nextOffset: number, criteria: DiscoveryCriteria): string {
      if (!isValidAreaId(areaId) || !isPositiveSafeInteger(nextOffset)) {
        throw invalidCursor();
      }
      const payload: CursorPayload = {
        version: 1,
        areaId,
        nextOffset,
        criteriaDigest: criteriaDigest(criteria),
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const encodedSignature = signature(encodedPayload).toString("base64url");
      const cursor = `${encodedPayload}.${encodedSignature}`;
      if (cursor.length > MAX_GEOAPIFY_CURSOR_CHARACTERS) {
        throw invalidCursor();
      }
      return cursor;
    },

    decode(cursor: string, criteria: DiscoveryCriteria): GeoapifyCursorValue {
      try {
        if (
          typeof cursor !== "string" ||
          cursor.length === 0 ||
          cursor.length > MAX_GEOAPIFY_CURSOR_CHARACTERS ||
          !/^[\x21-\x7e]+$/.test(cursor)
        ) {
          throw invalidCursor();
        }
        const parts = cursor.split(".");
        if (parts.length !== 2) {
          throw invalidCursor();
        }
        const [encodedPayload, encodedSignature] = parts;
        const suppliedSignature = decodeCanonicalBase64Url(encodedSignature!);
        const expectedSignature = signature(encodedPayload!);
        if (
          suppliedSignature.length !== expectedSignature.length ||
          !timingSafeEqual(suppliedSignature, expectedSignature)
        ) {
          throw invalidCursor();
        }
        const payloadBytes = decodeCanonicalBase64Url(encodedPayload!);
        const payload: unknown = JSON.parse(payloadBytes.toString("utf8"));
        if (!isExactPayload(payload) || payload.criteriaDigest !== criteriaDigest(criteria)) {
          throw invalidCursor();
        }
        return Object.freeze({ areaId: payload.areaId, offset: payload.nextOffset });
      } catch {
        throw invalidCursor();
      }
    },
  });
}
