import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  InvalidDiscoveryCriteriaError,
  MalformedDiscoveryResponseError,
  normalizeDiscoveryCandidate,
  normalizeDiscoveryCriteria,
  normalizeDiscoveryProviderId,
} from "../../src/discovery";

test("normalizes valid criteria and defaults maxResults to provider slot budget 20", () => {
  assert.deepEqual(
    normalizeDiscoveryCriteria({
      location: "  Gdańsk, Poland  ",
      query: "  independent bakery  ",
    }),
    {
      location: "Gdańsk, Poland",
      query: "independent bakery",
      maxResults: 20,
    },
  );
});

test("accepts the inclusive maxResults boundaries", () => {
  assert.equal(
    normalizeDiscoveryCriteria({ location: "Warsaw", query: "dentist", maxResults: 1 })
      .maxResults,
    1,
  );
  assert.equal(
    normalizeDiscoveryCriteria({ location: "Warsaw", query: "dentist", maxResults: 60 })
      .maxResults,
    60,
  );
});

test("rejects invalid maxResults values", () => {
  for (const maxResults of [0, 61, 1.5, Number.NaN, "20", null]) {
    assert.throws(
      () => normalizeDiscoveryCriteria({ location: "Warsaw", query: "dentist", maxResults }),
      InvalidDiscoveryCriteriaError,
    );
  }
});

test("rejects blank, controlled, and oversized criteria text", () => {
  for (const input of [
    { location: " ", query: "bakery" },
    { location: "Warsaw", query: "\t" },
    { location: "War\nsaw", query: "bakery" },
    { location: "Warsaw", query: "bakery\u007f" },
    { location: "😀".repeat(201), query: "bakery" },
    { location: "Warsaw", query: "ą".repeat(201) },
  ]) {
    assert.throws(() => normalizeDiscoveryCriteria(input), InvalidDiscoveryCriteriaError);
  }
});

test("accepts 200 Unicode characters and preserves spelling and case", () => {
  const location = "Ł".repeat(200);
  const result = normalizeDiscoveryCriteria({ location, query: "Web Design" });
  assert.equal(result.location, location);
  assert.equal(result.query, "Web Design");
});

test("rejects missing and unsupported criteria fields", () => {
  for (const input of [
    null,
    { location: "Warsaw" },
    { query: "bakery" },
    { location: "Warsaw", query: "bakery", radius: 10 },
  ]) {
    assert.throws(() => normalizeDiscoveryCriteria(input), InvalidDiscoveryCriteriaError);
  }
});

test("accepts bounded lowercase application provider identifiers", () => {
  assert.equal(normalizeDiscoveryProviderId("local_directory_2"), "local_directory_2");
  assert.equal(normalizeDiscoveryProviderId(`a${"b".repeat(63)}`).length, 64);
});

test("rejects invalid provider identifier formats safely", () => {
  for (const id of ["", "GooglePlaces", "google-places", "2_provider", "a".repeat(65)]) {
    assert.throws(() => normalizeDiscoveryProviderId(id), MalformedDiscoveryResponseError);
  }
});

test("normalizes a valid candidate and preserves opaque reference case", () => {
  assert.deepEqual(
    normalizeDiscoveryCandidate({
      provider: "directory",
      providerReference: "Place-ABC-123",
      businessName: "  Example Bakery  ",
      websiteUrl: "HTTPS://Example.COM/path",
    }),
    {
      status: "accepted",
      candidate: {
        provider: "directory",
        providerReference: "Place-ABC-123",
        businessName: "Example Bakery",
        websiteObservation: { presence: "present", url: "https://example.com/path" },
      },
      warnings: [],
    },
  );
});

test("maps an absent website to unknown without warning", () => {
  const outcome = normalizeDiscoveryCandidate({
    provider: "directory",
    providerReference: "ref-1",
    businessName: "Business",
  });
  assert.equal(outcome.status, "accepted");
  if (outcome.status === "accepted") {
    assert.deepEqual(outcome.candidate.websiteObservation, { presence: "unknown" });
    assert.deepEqual(outcome.warnings, []);
  }
});

test("downgrades an invalid optional website to unknown with a safe warning", () => {
  const secret = "do-not-reflect";
  const outcome = normalizeDiscoveryCandidate({
    provider: "directory",
    providerReference: "ref-1",
    businessName: "Business",
    websiteUrl: `https://user:${secret}@example.com/private`,
  });
  assert.deepEqual(outcome, {
    status: "accepted",
    candidate: {
      provider: "directory",
      providerReference: "ref-1",
      businessName: "Business",
      websiteObservation: { presence: "unknown" },
    },
    warnings: ["invalid_website"],
  });
  assert.ok(!JSON.stringify(outcome).includes(secret));
});

test("rejects invalid provider references as allowlisted outcomes", () => {
  for (const providerReference of [
    "",
    " reference ",
    "line\nbreak",
    "😀".repeat(513),
  ]) {
    assert.deepEqual(
      normalizeDiscoveryCandidate({
        provider: "directory",
        providerReference,
        businessName: "Business",
      }),
      { status: "rejected", code: "invalid_reference" },
    );
  }
});

test("rejects invalid business names as allowlisted outcomes", () => {
  for (const businessName of ["", "   ", "line\nbreak", "界".repeat(301)]) {
    assert.deepEqual(
      normalizeDiscoveryCandidate({
        provider: "directory",
        providerReference: "ref-1",
        businessName,
      }),
      { status: "rejected", code: "invalid_business_name" },
    );
  }
});

test("candidate website normalization performs no network request", () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (() => {
    requests += 1;
    throw new Error("Network must not be used.");
  }) as typeof fetch;
  try {
    const outcome = normalizeDiscoveryCandidate({
      provider: "directory",
      providerReference: "ref-1",
      businessName: "Business",
      websiteUrl: "https://not-resolved.invalid/",
    });
    assert.equal(outcome.status, "accepted");
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
