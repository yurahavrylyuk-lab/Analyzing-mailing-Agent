import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { normalizeDiscoveryCriteria } from "../../src/discovery";
import {
  createGeoapifyCursorCodec,
  MAX_GEOAPIFY_CURSOR_CHARACTERS,
} from "../../src/discovery/providers/geoapify/cursor";
import { DiscoveryProviderError } from "../../src/discovery/errors";

const KEY = Buffer.alloc(32, 7);
const CRITERIA = normalizeDiscoveryCriteria({
  location: " Warsaw ",
  query: " bakery ",
  maxResults: 12,
});

function assertInvalidCursor(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DiscoveryProviderError);
    assert.equal(error.code, "INVALID_CURSOR");
    return true;
  });
}

function signPayload(payload: unknown, key: Uint8Array = KEY): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(encoded, "ascii").digest("base64url");
  return `${encoded}.${signature}`;
}

test("cursor round-trips within one codec and binds to normalized criteria", () => {
  const codec = createGeoapifyCursorCodec(KEY);
  const cursor = codec.encode("city-area_1", 20, CRITERIA);

  assert.deepEqual(codec.decode(cursor, CRITERIA), { areaId: "city-area_1", offset: 20 });
  assert.deepEqual(codec.decode(cursor, CRITERIA), { areaId: "city-area_1", offset: 20 });
  assert.ok(cursor.length <= MAX_GEOAPIFY_CURSOR_CHARACTERS);
  assert.match(cursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const [encodedPayload] = cursor.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(payload).sort(), ["areaId", "criteriaDigest", "nextOffset", "version"]);
  assert.equal(payload.version, 1);
  assert.equal(payload.areaId, "city-area_1");
  assert.equal(payload.nextOffset, 20);
  assert.match(payload.criteriaDigest, /^[a-f0-9]{64}$/);
});

test("cursor rejects criteria changes and another adapter instance", () => {
  const codec = createGeoapifyCursorCodec(KEY);
  const cursor = codec.encode("area", 5, CRITERIA);

  for (const criteria of [
    normalizeDiscoveryCriteria({ location: "Krakow", query: "bakery", maxResults: 12 }),
    normalizeDiscoveryCriteria({ location: "Warsaw", query: "cafe", maxResults: 12 }),
    normalizeDiscoveryCriteria({ location: "Warsaw", query: "bakery", maxResults: 13 }),
  ]) {
    assertInvalidCursor(() => codec.decode(cursor, criteria));
  }
  assertInvalidCursor(() => createGeoapifyCursorCodec(Buffer.alloc(32, 8)).decode(cursor, CRITERIA));
});

test("cursor rejects payload and signature tampering", () => {
  const codec = createGeoapifyCursorCodec(KEY);
  const cursor = codec.encode("area", 2, CRITERIA);
  const [payload, signature] = cursor.split(".");

  assertInvalidCursor(() => codec.decode(`${payload}A.${signature}`, CRITERIA));
  assertInvalidCursor(() => codec.decode(`${payload}.${signature!.slice(0, -1)}A`, CRITERIA));
  assertInvalidCursor(() => codec.decode("not-a-cursor", CRITERIA));
  assertInvalidCursor(() => codec.decode("%invalid.signature", CRITERIA));
});

test("cursor requires exact payload keys, version, and field types", () => {
  const valid = JSON.parse(
    Buffer.from(createGeoapifyCursorCodec(KEY).encode("area", 2, CRITERIA).split(".")[0]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;

  for (const payload of [
    { ...valid, extra: true },
    { areaId: valid.areaId, nextOffset: valid.nextOffset, criteriaDigest: valid.criteriaDigest },
    { ...valid, version: 2 },
    { ...valid, version: "1" },
    { ...valid, areaId: 1 },
    { ...valid, nextOffset: "2" },
    { ...valid, criteriaDigest: 1 },
  ]) {
    assertInvalidCursor(() => createGeoapifyCursorCodec(KEY).decode(signPayload(payload), CRITERIA));
  }
});

test("cursor validates area tokens and positive safe offsets on encode and decode", () => {
  const codec = createGeoapifyCursorCodec(KEY);

  for (const areaId of ["", "area space", "area/slash", "a".repeat(513)]) {
    assertInvalidCursor(() => codec.encode(areaId, 1, CRITERIA));
  }
  for (const nextOffset of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
    assertInvalidCursor(() => codec.encode("area", nextOffset, CRITERIA));
  }

  const valid = JSON.parse(
    Buffer.from(codec.encode("area", 1, CRITERIA).split(".")[0]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assertInvalidCursor(() => codec.decode(signPayload({ ...valid, areaId: "bad area" }), CRITERIA));
  assertInvalidCursor(() => codec.decode(signPayload({ ...valid, nextOffset: Number.MAX_SAFE_INTEGER + 1 }), CRITERIA));
});

test("cursor rejects invalid keys, encodings, and oversized tokens", () => {
  for (const key of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)]) {
    assert.throws(() => createGeoapifyCursorCodec(key), TypeError);
  }

  const codec = createGeoapifyCursorCodec(KEY);
  assertInvalidCursor(() => codec.decode("a".repeat(MAX_GEOAPIFY_CURSOR_CHARACTERS + 1), CRITERIA));
  assertInvalidCursor(() => codec.decode("e30=.signature", CRITERIA));
  assertInvalidCursor(() => codec.decode("....", CRITERIA));
});
