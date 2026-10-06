import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  MalformedDiscoveryResponseError,
  normalizeDiscoveryCandidate,
  normalizeDiscoveryCriteria,
  normalizeDiscoveryPage,
  type DiscoveryCandidateOutcome,
} from "../../src/discovery";
import { FakeDiscoveryProvider } from "../helpers/fake-discovery-provider";

function accepted(reference: string): DiscoveryCandidateOutcome {
  return normalizeDiscoveryCandidate({
    provider: "directory",
    providerReference: reference,
    businessName: `Business ${reference}`,
  });
}

test("normalizes a valid page while preserving one ordered outcome per slot", () => {
  const first = accepted("one");
  const rejected: DiscoveryCandidateOutcome = {
    status: "rejected",
    code: "invalid_business_name",
  };
  const third = accepted("three");
  const page = normalizeDiscoveryPage(
    { outcomes: [first, rejected, third], nextCursor: "opaque cursor value" },
    3,
    "directory",
  );
  assert.deepEqual(page.outcomes, [first, rejected, third]);
  assert.equal(page.nextCursor, "opaque cursor value");
  assert.ok(Object.isFrozen(page));
  assert.ok(Object.isFrozen(page.outcomes));
});

test("accepts a page without a cursor", () => {
  assert.deepEqual(normalizeDiscoveryPage({ outcomes: [] }, 20, "directory"), {
    outcomes: [],
  });
});

test("rejects blank, controlled, and oversized cursors", () => {
  for (const nextCursor of ["", "   ", "line\nbreak", "x".repeat(8193)]) {
    assert.throws(
      () => normalizeDiscoveryPage({ outcomes: [], nextCursor }, 20, "directory"),
      MalformedDiscoveryResponseError,
    );
  }
});

test("accepts an opaque cursor at the 8192-character boundary", () => {
  const nextCursor = "x".repeat(8192);
  assert.equal(
    normalizeDiscoveryPage({ outcomes: [], nextCursor }, 20, "directory").nextCursor,
    nextCursor,
  );
});

test("rejects invalid requested page sizes and oversized result pages", () => {
  for (const pageSize of [0, 21, 1.5]) {
    assert.throws(
      () => normalizeDiscoveryPage({ outcomes: [] }, pageSize, "directory"),
      MalformedDiscoveryResponseError,
    );
  }
  assert.throws(
    () => normalizeDiscoveryPage({ outcomes: [accepted("1"), accepted("2")] }, 1, "directory"),
    MalformedDiscoveryResponseError,
  );
});

test("rejects accepted candidates whose provider does not match the provider contract", () => {
  const mismatched = normalizeDiscoveryCandidate({
    provider: "other_directory",
    providerReference: "ref",
    businessName: "Business",
  });
  assert.throws(
    () => normalizeDiscoveryPage({ outcomes: [mismatched] }, 1, "directory"),
    MalformedDiscoveryResponseError,
  );
});

test("rejects malformed or unsupported outcome fields", () => {
  for (const outcome of [
    { status: "rejected", code: "provider_error" },
    { status: "rejected", code: "invalid_reference", raw: "secret" },
    { status: "accepted", candidate: {}, warnings: [] },
  ]) {
    assert.throws(
      () => normalizeDiscoveryPage({ outcomes: [outcome] }, 1, "directory"),
      MalformedDiscoveryResponseError,
    );
  }
});

test("fake provider returns deterministic offline pages and receives AbortSignal", async () => {
  const first = normalizeDiscoveryPage({ outcomes: [accepted("one")], nextCursor: "next" }, 1, "directory");
  const second = normalizeDiscoveryPage({ outcomes: [accepted("two")] }, 1, "directory");
  const provider = new FakeDiscoveryProvider("directory", [first, second]);
  const controller = new AbortController();
  const criteria = normalizeDiscoveryCriteria({ location: "Warsaw", query: "bakery" });

  assert.equal(
    (await provider.searchPage({ criteria, pageSize: 1, signal: controller.signal })),
    first,
  );
  assert.equal(
    (await provider.searchPage({
      criteria,
      pageSize: 1,
      cursor: first.nextCursor,
      signal: controller.signal,
    })),
    second,
  );
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0]?.signal, controller.signal);
  assert.equal(provider.requests[1]?.cursor, "next");
});
