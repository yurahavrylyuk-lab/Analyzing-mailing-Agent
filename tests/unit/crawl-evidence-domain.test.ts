import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CRAWL_PAGE_ERROR_CODES } from "../../src/crawler/errors";
import { MAX_CRAWL_BODY_BYTES, MAX_CRAWL_REDIRECTS } from "../../src/crawler/domain";
import {
  CRAWL_EVIDENCE_PERSISTENCE_ERROR_CODES,
  CrawlEvidencePersistenceError,
  normalizeSinglePageCrawlEvidence,
} from "../../src/crawler/evidence-domain";
import { normalizeWebsiteUrl } from "../../src/leads/domain";
import { NETWORK_TARGET_ERROR_CODES } from "../../src/network-safety/errors";

const leadId = "00000000-0000-4000-8000-000000000001";
const attemptedAt = "2026-10-21T14:05:06.007Z";
const requestedUrl = normalizeWebsiteUrl("https://example.com/requested");
const finalUrl = normalizeWebsiteUrl("https://example.com/final");
const privateUrl = normalizeWebsiteUrl("http://127.0.0.1/historical");
const portUrl = normalizeWebsiteUrl("http://10.0.0.8:8080/a");
const hashUrl = normalizeWebsiteUrl("https://example.com/path#section");

const fetchedKeys = [
  "attemptedAt",
  "bodyText",
  "byteLength",
  "contentType",
  "finalUrl",
  "leadId",
  "leadVersion",
  "outcome",
  "redirectCount",
  "requestedUrl",
  "statusCode",
];

const failedKeys = [
  "attemptedAt",
  "failure",
  "leadId",
  "leadVersion",
  "outcome",
  "requestedUrl",
];

function fetched(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "fetched",
    leadId,
    leadVersion: 4,
    requestedUrl,
    finalUrl,
    statusCode: 200,
    contentType: "text/html",
    bodyText: "<p>héllo</p>",
    byteLength: Buffer.byteLength("<p>héllo</p>", "utf8"),
    redirectCount: 1,
    attemptedAt,
    ...overrides,
  };
}

function failed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "failed",
    leadId,
    leadVersion: 4,
    requestedUrl,
    failure: "BLOCKED_HOST",
    attemptedAt,
    ...overrides,
  };
}

function assertInvalid(input: unknown): void {
  assert.throws(
    () => normalizeSinglePageCrawlEvidence(input),
    (error: unknown) =>
      error instanceof CrawlEvidencePersistenceError &&
      error.name === "CrawlEvidencePersistenceError" &&
      error.code === "INVALID_EVIDENCE" &&
      error.message === "Crawl evidence is invalid." &&
      !("cause" in error),
  );
}

test("publishes the fixed persistence error codes and messages", () => {
  assert.equal(Object.isFrozen(CRAWL_EVIDENCE_PERSISTENCE_ERROR_CODES), true);
  assert.deepEqual(
    [...CRAWL_EVIDENCE_PERSISTENCE_ERROR_CODES],
    ["INVALID_EVIDENCE", "LEAD_NOT_FOUND", "PERSISTENCE_FAILED"],
  );

  const messages = {
    INVALID_EVIDENCE: "Crawl evidence is invalid.",
    LEAD_NOT_FOUND: "Business lead was not found.",
    PERSISTENCE_FAILED: "Crawl evidence persistence failed.",
  } as const;
  for (const code of CRAWL_EVIDENCE_PERSISTENCE_ERROR_CODES) {
    const error = new CrawlEvidencePersistenceError(code);
    assert.equal(error.message, messages[code]);
    assert.equal(error.name, "CrawlEvidencePersistenceError");
    assert.equal(error.code, code);
    assert.equal("cause" in error, false);
  }
});

test("accepts frozen fetched evidence with exact keys and preserves the body", () => {
  const input = fetched();
  const result = normalizeSinglePageCrawlEvidence(input);

  assert.equal(Object.isFrozen(result), true);
  assert.notEqual(result, input);
  assert.equal(result.outcome, "fetched");
  if (result.outcome !== "fetched") {
    return;
  }
  assert.deepEqual(Object.keys(result).sort(), fetchedKeys);
  assert.equal("failure" in result, false);
  assert.equal(result.leadId, leadId);
  assert.equal(result.leadVersion, 4);
  assert.equal(result.requestedUrl, requestedUrl);
  assert.equal(result.finalUrl, finalUrl);
  assert.equal(result.statusCode, 200);
  assert.equal(result.contentType, "text/html");
  assert.equal(result.bodyText, "<p>héllo</p>");
  assert.equal(result.byteLength, Buffer.byteLength("<p>héllo</p>", "utf8"));
  assert.equal(result.redirectCount, 1);
  assert.equal(result.attemptedAt, attemptedAt);
  assert.deepEqual(input, fetched());
});

test("accepts frozen failed evidence with one network code and one crawl code", () => {
  for (const failure of [NETWORK_TARGET_ERROR_CODES[0], CRAWL_PAGE_ERROR_CODES[0]]) {
    const input = failed({ failure, requestedUrl: privateUrl });
    const result = normalizeSinglePageCrawlEvidence(input);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(result.outcome, "failed");
    if (result.outcome !== "failed") {
      continue;
    }
    assert.deepEqual(Object.keys(result).sort(), failedKeys);
    assert.equal("bodyText" in result, false);
    assert.equal("finalUrl" in result, false);
    assert.equal(result.failure, failure);
    assert.equal(result.requestedUrl, privateUrl);
    assert.equal(result.attemptedAt, attemptedAt);
  }

  const httpFailure = normalizeSinglePageCrawlEvidence(failed({ failure: "HTTP_FAILURE" }));
  assert.equal(httpFailure.outcome, "failed");
  if (httpFailure.outcome === "failed") {
    assert.equal(httpFailure.failure, "HTTP_FAILURE");
  }
});

test("keeps canonical storage URLs, including a port, a private host, and a hash", () => {
  for (const url of [requestedUrl, privateUrl, portUrl, hashUrl]) {
    const result = normalizeSinglePageCrawlEvidence(fetched({ requestedUrl: url, finalUrl: url }));
    assert.equal(result.outcome, "fetched");
    if (result.outcome === "fetched") {
      assert.equal(result.requestedUrl, url);
      assert.equal(result.finalUrl, url);
    }
    const failedResult = normalizeSinglePageCrawlEvidence(failed({ requestedUrl: url }));
    assert.equal(failedResult.requestedUrl, url);
  }
});

test("rejects a non-canonical URL instead of rewriting it", () => {
  assertInvalid(fetched({ requestedUrl: "HTTPS://Example.COM/requested" }));
  assertInvalid(fetched({ finalUrl: "HTTPS://Example.COM/final" }));
  assertInvalid(failed({ requestedUrl: "https://example.com" }));
  assertInvalid(fetched({ requestedUrl: "not-a-url" }));
  assertInvalid(fetched({ finalUrl: " http://example.com/final" }));
});

test("accepts only a canonical attemptedAt and returns that same string", () => {
  const canonical = "2026-02-03T04:05:06.789Z";
  const result = normalizeSinglePageCrawlEvidence(failed({ attemptedAt: canonical }));
  assert.equal(result.attemptedAt, canonical);
  assertInvalid(fetched({ attemptedAt: "2026-10-21T14:05:06Z" }));
  assertInvalid(fetched({ attemptedAt: "2026-10-21T14:05:06.007+00:00" }));
  assertInvalid(fetched({ attemptedAt: "2026-02-31T00:00:00.000Z" }));
  assertInvalid(fetched({ attemptedAt: "2026-10-21 14:05:06.007Z" }));
  assertInvalid(failed({ attemptedAt: 1 }));
});

test("rejects invalid discriminators, lead ids, versions, and extra or missing fields", () => {
  assertInvalid(null);
  assertInvalid([]);
  assertInvalid("fetched");
  assertInvalid(fetched({ outcome: "partial" }));
  assertInvalid(fetched({ outcome: "failed" }));
  const { outcome: _outcome, ...withoutOutcome } = fetched();
  assertInvalid(withoutOutcome);
  assertInvalid(fetched({ leadId: "not-a-uuid" }));
  assertInvalid(fetched({ leadId: "" }));
  assertInvalid(failed({ leadVersion: 0 }));
  assertInvalid(failed({ leadVersion: -1 }));
  assertInvalid(failed({ leadVersion: 1.5 }));
  assertInvalid(failed({ leadVersion: Number.MAX_SAFE_INTEGER + 1 }));
  assertInvalid(failed({ leadVersion: "1" }));
  assert.equal(
    normalizeSinglePageCrawlEvidence(failed({ leadVersion: Number.MAX_SAFE_INTEGER })).leadVersion,
    Number.MAX_SAFE_INTEGER,
  );
  assertInvalid(fetched({ message: "secret" }));
  assertInvalid(fetched({ stack: "secret" }));
  assertInvalid(fetched({ hostname: "example.com" }));
  assertInvalid(fetched({ ip: "203.0.113.10" }));
  assertInvalid(fetched({ failure: "TIMEOUT" }));
  assertInvalid(failed({ bodyText: "<p></p>" }));
  assertInvalid(failed({ finalUrl }));
  assertInvalid(failed({ statusCode: 200 }));
  assertInvalid(failed({ message: "secret" }));
  assertInvalid(failed({ stack: "secret" }));
  assertInvalid(failed({ hostname: "example.com" }));
  assertInvalid(failed({ ip: "203.0.113.10" }));
  const { failure: _failure, ...withoutFailure } = failed();
  assertInvalid(withoutFailure);
});

test("enforces fetched content, status, redirects, and the UTF-8 body bound", () => {
  assert.equal(MAX_CRAWL_BODY_BYTES, 1_048_576);
  assert.equal(MAX_CRAWL_REDIRECTS, 5);
  assert.equal(
    normalizeSinglePageCrawlEvidence(fetched({ contentType: "application/xhtml+xml" })).outcome,
    "fetched",
  );
  assertInvalid(fetched({ contentType: "text/plain" }));
  assertInvalid(fetched({ contentType: "text/html; charset=utf-8" }));
  assertInvalid(fetched({ statusCode: 201 }));
  assertInvalid(fetched({ statusCode: 404 }));
  assertInvalid(fetched({ statusCode: "200" }));
  assertInvalid(fetched({ redirectCount: -1 }));
  assertInvalid(fetched({ redirectCount: 6 }));
  assertInvalid(fetched({ redirectCount: 1.5 }));
  assert.equal(
    normalizeSinglePageCrawlEvidence(fetched({ redirectCount: 0, bodyText: "", byteLength: 0 }))
      .outcome,
    "fetched",
  );
  assert.equal(
    normalizeSinglePageCrawlEvidence(fetched({ redirectCount: 5 })).outcome,
    "fetched",
  );

  const exact = "a".repeat(MAX_CRAWL_BODY_BYTES);
  const exactResult = normalizeSinglePageCrawlEvidence(
    fetched({ bodyText: exact, byteLength: MAX_CRAWL_BODY_BYTES, redirectCount: 0 }),
  );
  assert.equal(exactResult.outcome, "fetched");
  if (exactResult.outcome === "fetched") {
    assert.equal(exactResult.bodyText, exact);
    assert.equal(exactResult.byteLength, MAX_CRAWL_BODY_BYTES);
  }
  assertInvalid(fetched({ bodyText: `${exact}a`, byteLength: MAX_CRAWL_BODY_BYTES + 1 }));
  assertInvalid(fetched({ bodyText: "abc", byteLength: 2 }));
  assertInvalid(fetched({ bodyText: "\uD800", byteLength: 3 }));
  assertInvalid(failed({ failure: "NOT_A_CODE" }));
  assertInvalid(failed({ failure: "" }));
});
