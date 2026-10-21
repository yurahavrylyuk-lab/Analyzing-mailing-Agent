import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type {
  CrawlEvidenceErrorCode,
  CrawlEvidenceFailureCode,
  FailedCrawlEvidence,
  FetchedCrawlEvidence,
  SinglePageCrawlEvidence,
} from "../../src/crawler";
import { CRAWL_PAGE_ERROR_CODES, CrawlPageError } from "../../src/crawler/errors";
import type { CrawlPageContentType, CrawlPageResult } from "../../src/crawler/domain";
import {
  CRAWL_EVIDENCE_ERROR_CODES,
  CrawlEvidenceError,
  collectSinglePageCrawlEvidenceWithDependencies,
  type CrawlPageFetcher,
} from "../../src/crawler/single-page-evidence";
import {
  createBusinessLead,
  createDiscoveredBusinessLead,
  type BusinessLead,
  type LeadStatus,
} from "../../src/leads/domain";
import {
  NETWORK_TARGET_ERROR_CODES,
  NetworkTargetError,
} from "../../src/network-safety/errors";

const FIXED_INSTANT = "2026-10-21T07:00:00.000Z";
const BUSINESS_NAME = "Marker Bakery";
const MANUAL_URL = "https://manual.example/about";
const DISCOVERED_URL = "https://discovered.example/menu";
const FETCHER_REQUESTED_URL = "https://fetcher.example/normalized";

const invalidCode: CrawlEvidenceErrorCode = "INVALID_REQUEST";
const blockedCode: CrawlEvidenceFailureCode = "BLOCKED_ADDRESS";

type RecordedFetch = {
  input: unknown;
  signal: AbortSignal;
};

type Session = {
  calls: RecordedFetch[];
  events: string[];
  dependencies: {
    fetchPage: CrawlPageFetcher;
    clock: () => Date;
  };
};

function storedUrl(lead: BusinessLead): string {
  const observation = lead.websiteObservation;
  if (observation.presence !== "present") {
    throw new Error("Expected a present website observation.");
  }
  return observation.url;
}

function manualLead(observation: BusinessLead["websiteObservation"], id = "00000000-0000-4000-8000-000000000021"): BusinessLead {
  return createBusinessLead(
    {
      businessName: BUSINESS_NAME,
      sourceKind: "manual",
      sourceReference: "manual-marker",
      websiteObservation: observation,
    },
    id,
    new Date("2026-03-01T00:00:00.000Z"),
  );
}

function discoveredLead(): BusinessLead {
  return createDiscoveredBusinessLead(
    {
      provider: "geoapify",
      providerReference: "osm:n:21",
      businessName: "Discovered Marker Cafe",
      websiteObservation: { presence: "present", url: DISCOVERED_URL },
    },
    "00000000-0000-4000-8000-000000000022",
    new Date("2026-03-02T00:00:00.000Z"),
  );
}

function page(input: {
  finalUrl: string;
  contentType: CrawlPageContentType;
  bodyText: string;
  redirectCount: number;
}): CrawlPageResult {
  return Object.freeze({
    requestedUrl: FETCHER_REQUESTED_URL,
    finalUrl: input.finalUrl,
    statusCode: 200,
    contentType: input.contentType,
    bodyText: input.bodyText,
    byteLength: input.bodyText.length,
    redirectCount: input.redirectCount,
  });
}

const manualPage = page({
  finalUrl: "https://final.example/manual",
  contentType: "text/html",
  bodyText: "<html>manual</html>",
  redirectCount: 1,
});

const discoveredPage = page({
  finalUrl: "https://final.example/discovered",
  contentType: "application/xhtml+xml",
  bodyText: "<html>discovered</html>",
  redirectCount: 3,
});

function createSession(options: {
  page?: CrawlPageResult;
  throwError?: unknown;
  now?: () => Date;
} = {}): Session {
  const calls: RecordedFetch[] = [];
  const events: string[] = [];
  const clock = () => {
    events.push("clock");
    if (options.now !== undefined) {
      return options.now();
    }
    return new Date(FIXED_INSTANT);
  };
  const fetchPage: CrawlPageFetcher = async (input, signal) => {
    events.push("fetch");
    calls.push({ input, signal });
    if (options.throwError !== undefined) {
      throw options.throwError;
    }
    if (options.page === undefined) {
      throw new Error("Test fetch has no page.");
    }
    return options.page;
  };
  return { calls, events, dependencies: { fetchPage, clock } };
}

function collect(lead: BusinessLead, signal: AbortSignal, session: Session): Promise<SinglePageCrawlEvidence> {
  return collectSinglePageCrawlEvidenceWithDependencies(lead, signal, session.dependencies);
}

function invalidRequest(forbidden: readonly string[]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof CrawlEvidenceError);
    if (!(error instanceof CrawlEvidenceError)) {
      return false;
    }
    assert.equal(error.name, "CrawlEvidenceError");
    assert.equal(error.code, invalidCode);
    assert.equal(error.message, "Crawl evidence request is invalid.");
    for (const text of forbidden) {
      assert.equal(error.message.includes(text), false, text);
    }
    return true;
  };
}

function assertFetched(
  evidence: SinglePageCrawlEvidence,
  lead: BusinessLead,
  result: CrawlPageResult,
): asserts evidence is FetchedCrawlEvidence {
  assert.equal(evidence.outcome, "fetched");
  if (evidence.outcome !== "fetched") {
    return;
  }
  assert.deepEqual(evidence, {
    outcome: "fetched",
    leadId: lead.id,
    leadVersion: lead.version,
    requestedUrl: storedUrl(lead),
    finalUrl: result.finalUrl,
    statusCode: result.statusCode,
    contentType: result.contentType,
    bodyText: result.bodyText,
    byteLength: result.byteLength,
    redirectCount: result.redirectCount,
    attemptedAt: FIXED_INSTANT,
  });
  assert.equal(Object.isFrozen(evidence), true);
  assert.notEqual(evidence, result);
  assert.notEqual(evidence.requestedUrl, result.requestedUrl);
  assert.throws(() => {
    (evidence as { bodyText: string }).bodyText = "changed";
  });
}

function assertFailed(
  evidence: SinglePageCrawlEvidence,
  lead: BusinessLead,
  failure: CrawlEvidenceFailureCode,
  hidden: readonly string[],
): asserts evidence is FailedCrawlEvidence {
  assert.equal(evidence.outcome, "failed");
  if (evidence.outcome !== "failed") {
    return;
  }
  assert.deepEqual(evidence, {
    outcome: "failed",
    leadId: lead.id,
    leadVersion: lead.version,
    requestedUrl: storedUrl(lead),
    failure,
    attemptedAt: FIXED_INSTANT,
  });
  assert.equal(Object.isFrozen(evidence), true);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("Crawl evidence request is invalid."), false);
  for (const text of hidden) {
    assert.equal(serialized.includes(text), false, text);
  }
  for (const absent of ["message", "bodyText", "finalUrl", "statusCode", "contentType", "cause", "headers"]) {
    assert.equal(Object.hasOwn(evidence, absent), false, absent);
  }
  assert.throws(() => {
    (evidence as { failure: string }).failure = "changed";
  });
}

test("crawl evidence error codes are exactly INVALID_REQUEST", () => {
  assert.deepEqual([...CRAWL_EVIDENCE_ERROR_CODES], ["INVALID_REQUEST"]);
  assert.equal(Object.isFrozen(CRAWL_EVIDENCE_ERROR_CODES), true);
  const error = new CrawlEvidenceError("INVALID_REQUEST");
  assert.equal(error.message, "Crawl evidence request is invalid.");
  assert.equal(error.name, "CrawlEvidenceError");
  assert.equal(error.code, "INVALID_REQUEST");
});

test("fetches a present manual lead once and returns frozen evidence", async () => {
  const lead = manualLead({ presence: "present", url: MANUAL_URL });
  const before = structuredClone(lead);
  const signal = new AbortController().signal;
  const session = createSession({ page: manualPage });

  const evidence = await collect(lead, signal, session);

  assert.deepEqual(session.events, ["clock", "fetch"]);
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0]?.input, storedUrl(lead));
  assert.equal(typeof session.calls[0]?.input, "string");
  assert.equal(session.calls[0]?.signal, signal);
  assertFetched(evidence, lead, manualPage);
  assert.equal(evidence.leadId, lead.id);
  assert.equal(evidence.leadVersion, lead.version);
  assert.equal(evidence.requestedUrl, storedUrl(lead));
  assert.equal(evidence.finalUrl, manualPage.finalUrl);
  assert.equal(evidence.statusCode, manualPage.statusCode);
  assert.equal(evidence.contentType, manualPage.contentType);
  assert.equal(evidence.bodyText, manualPage.bodyText);
  assert.equal(evidence.byteLength, manualPage.byteLength);
  assert.equal(evidence.redirectCount, manualPage.redirectCount);
  assert.equal(evidence.attemptedAt, FIXED_INSTANT);
  assert.deepEqual(lead, before);
});

test("fetches a present discovered lead once and copies that snapshot", async () => {
  const lead = discoveredLead();
  const before = structuredClone(lead);
  const signal = new AbortController().signal;
  const session = createSession({ page: discoveredPage });

  const evidence = await collect(lead, signal, session);

  assert.deepEqual(session.events, ["clock", "fetch"]);
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0]?.input, storedUrl(lead));
  assert.equal(session.calls[0]?.signal, signal);
  assertFetched(evidence, lead, discoveredPage);
  assert.equal(evidence.leadId, lead.id);
  assert.equal(evidence.leadVersion, 1);
  assert.deepEqual(lead, before);
});

test("copies leadVersion 4 from the caller snapshot", async () => {
  const lead = Object.freeze({ ...manualLead({ presence: "present", url: MANUAL_URL }), version: 4 });
  const before = structuredClone(lead);
  const signal = new AbortController().signal;
  const session = createSession({ page: manualPage });

  const evidence = await collect(lead, signal, session);

  assert.equal(session.calls.length, 1);
  assert.equal(session.events.filter((event) => event === "clock").length, 1);
  assertFetched(evidence, lead, manualPage);
  assert.equal(evidence.leadVersion, 4);
  assert.equal(lead.version, 4);
  assert.deepEqual(lead, before);
});

test("fetches present reviewing and archived leads once", async () => {
  const recorded = manualLead({ presence: "present", url: MANUAL_URL });
  for (const status of ["reviewing", "archived"] as const satisfies readonly LeadStatus[]) {
    const lead = Object.freeze({ ...recorded, status });
    const before = structuredClone(lead);
    const signal = new AbortController().signal;
    const session = createSession({ page: manualPage });

    const evidence = await collect(lead, signal, session);

    assert.equal(session.calls.length, 1);
    assert.equal(session.calls[0]?.input, storedUrl(lead));
    assert.equal(session.calls[0]?.signal, signal);
    assert.deepEqual(session.events, ["clock", "fetch"]);
    assertFetched(evidence, lead, manualPage);
    assert.equal(lead.status, status);
    assert.deepEqual(lead, before);
  }
});

test("rejects unknown, missing, a non-signal, and a non-string url before the clock", async () => {
  const unknownLead = manualLead({ presence: "unknown" }, "00000000-0000-4000-8000-000000000031");
  const missingLead = manualLead({ presence: "missing" }, "00000000-0000-4000-8000-000000000032");
  const presentLead = manualLead({ presence: "present", url: MANUAL_URL });
  const numericUrl = Object.freeze({
    ...presentLead,
    websiteObservation: Object.freeze({ presence: "present", url: 404 }),
  }) as unknown as BusinessLead;
  const cases: Array<{ lead: BusinessLead; signal: unknown; forbidden: string[] }> = [
    { lead: unknownLead, signal: new AbortController().signal, forbidden: [BUSINESS_NAME, unknownLead.id] },
    { lead: missingLead, signal: new AbortController().signal, forbidden: [BUSINESS_NAME, missingLead.id] },
    { lead: presentLead, signal: undefined, forbidden: [BUSINESS_NAME, MANUAL_URL, presentLead.id] },
    { lead: presentLead, signal: null, forbidden: [MANUAL_URL] },
    { lead: presentLead, signal: {}, forbidden: [MANUAL_URL] },
    { lead: presentLead, signal: new AbortController(), forbidden: [MANUAL_URL] },
    { lead: presentLead, signal: "abort", forbidden: [MANUAL_URL] },
    {
      lead: presentLead,
      signal: { aborted: true, reason: "secret-signal-reason" },
      forbidden: ["secret-signal-reason", MANUAL_URL, presentLead.id],
    },
    { lead: numericUrl, signal: new AbortController().signal, forbidden: [BUSINESS_NAME, presentLead.id] },
  ];

  for (const [index, entry] of cases.entries()) {
    const before = structuredClone(entry.lead);
    const session = createSession({ page: manualPage });
    await assert.rejects(
      () => collect(entry.lead, entry.signal as AbortSignal, session),
      invalidRequest(entry.forbidden),
      `case ${index}`,
    );
    assert.deepEqual(session.events, [], `case ${index} events`);
    assert.deepEqual(session.calls, [], `case ${index} calls`);
    assert.deepEqual(entry.lead, before, `case ${index} lead`);
  }
});

test("maps every network and crawl error code to failed evidence", async () => {
  const lead = manualLead({ presence: "present", url: MANUAL_URL });
  const thrown = [
    ...CRAWL_PAGE_ERROR_CODES.map((code) => new CrawlPageError(code)),
    ...NETWORK_TARGET_ERROR_CODES.map((code) => new NetworkTargetError(code)),
  ];
  assert.equal(thrown.some((error) => error.code === "CANCELLED"), true);
  assert.equal(thrown.some((error) => error.code === "TIMEOUT"), true);
  assert.equal(thrown.some((error) => error.code === "HTTP_FAILURE"), true);
  assert.equal(thrown.some((error) => error.code === blockedCode), true);

  for (const error of thrown) {
    const before = structuredClone(lead);
    const signal = new AbortController().signal;
    const session = createSession({ throwError: error });
    const evidence = await collect(lead, signal, session);

    assert.deepEqual(session.events, ["clock", "fetch"]);
    assert.equal(session.calls.length, 1);
    assert.equal(session.calls[0]?.input, storedUrl(lead));
    assert.equal(session.calls[0]?.signal, signal);
    assertFailed(evidence, lead, error.code, [error.message, BUSINESS_NAME]);
    assert.equal(evidence.failure, error.code);
    assert.equal(evidence.leadId, lead.id);
    assert.equal(evidence.leadVersion, lead.version);
    assert.equal(evidence.requestedUrl, storedUrl(lead));
    assert.equal(evidence.attemptedAt, FIXED_INSTANT);
    assert.deepEqual(lead, before);
    if (
      error.code === "CANCELLED" ||
      error.code === "TIMEOUT" ||
      error.code === "HTTP_FAILURE" ||
      error.code === "BLOCKED_ADDRESS"
    ) {
      assert.equal(evidence.failure, error.code);
      assert.equal(JSON.stringify(evidence).includes(error.message), false);
    }
  }
});

test("propagates an ordinary error and a duck-typed failure as the same object", async () => {
  const lead = manualLead({ presence: "present", url: MANUAL_URL });
  const ordinary = new Error("ordinary-marker-not-evidence");
  const duck = new Error("Crawl request was cancelled.");
  duck.name = "CrawlPageError";
  Object.assign(duck, { code: "CANCELLED" });

  for (const error of [ordinary, duck]) {
    const session = createSession({ throwError: error });
    await assert.rejects(
      () => collect(lead, new AbortController().signal, session),
      (caught: unknown) => {
        assert.equal(caught, error);
        assert.equal(caught instanceof CrawlEvidenceError, false);
        return true;
      },
    );
    assert.deepEqual(session.events, ["clock", "fetch"]);
  }
});

test("runs the clock once per eligible attempt and twice across sequential calls", async () => {
  const lead = manualLead({ presence: "present", url: MANUAL_URL });
  const before = structuredClone(lead);
  const first = new AbortController().signal;
  const second = new AbortController().signal;
  const session = createSession({ page: manualPage });

  await collect(lead, first, session);
  await collect(lead, second, session);

  assert.deepEqual(session.events, ["clock", "fetch", "clock", "fetch"]);
  assert.equal(session.calls.length, 2);
  assert.equal(session.calls[0]?.signal, first);
  assert.equal(session.calls[1]?.signal, second);
  assert.deepEqual(lead, before);
});

test("propagates a clock failure without calling the fetcher", async () => {
  const lead = manualLead({ presence: "present", url: MANUAL_URL });
  const clockError = new Error("clock-marker");
  const session = createSession({
    page: manualPage,
    now: () => {
      throw clockError;
    },
  });

  await assert.rejects(
    () => collect(lead, new AbortController().signal, session),
    (error: unknown) => error === clockError,
  );
  assert.deepEqual(session.events, ["clock"]);
  assert.deepEqual(session.calls, []);
});

test("propagates an invalid clock date without calling the fetcher", async () => {
  const lead = manualLead({ presence: "present", url: MANUAL_URL });
  const session = createSession({
    page: manualPage,
    now: () => new Date(Number.NaN),
  });

  await assert.rejects(
    () => collect(lead, new AbortController().signal, session),
    (error: unknown) => error instanceof RangeError && !(error instanceof CrawlEvidenceError),
  );
  assert.deepEqual(session.calls, []);
});

test("propagates a lead read failure without calling the clock or fetcher", async () => {
  const marker = new Error("lead-read-failed");
  const lead = new Proxy({} as BusinessLead, {
    get() {
      throw marker;
    },
  });
  const session = createSession({ page: manualPage });

  await assert.rejects(
    () => collect(lead, new AbortController().signal, session),
    (error: unknown) => error === marker && !(error instanceof CrawlEvidenceError),
  );
  assert.deepEqual(session.events, []);
  assert.deepEqual(session.calls, []);

  const nullSession = createSession({ page: manualPage });
  await assert.rejects(
    () => collect(null as unknown as BusinessLead, new AbortController().signal, nullSession),
    (error: unknown) => error instanceof TypeError && !(error instanceof CrawlEvidenceError),
  );
  assert.deepEqual(nullSession.events, []);
  assert.deepEqual(nullSession.calls, []);
});

test("forwards an already-aborted signal and records CANCELLED", async () => {
  const lead = manualLead({ presence: "present", url: MANUAL_URL });
  const before = structuredClone(lead);
  const controller = new AbortController();
  controller.abort("abort-reason-marker");
  const session = createSession({ throwError: new CrawlPageError("CANCELLED") });

  const evidence = await collect(lead, controller.signal, session);

  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(session.events, ["clock", "fetch"]);
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0]?.signal, controller.signal);
  assertFailed(evidence, lead, "CANCELLED", ["abort-reason-marker", "Crawl request was cancelled."]);
  assert.equal(evidence.attemptedAt, FIXED_INSTANT);
  assert.deepEqual(lead, before);
});

test("exports the production crawl evidence API and keeps the dependency seam private", () => {
  const crawler = require("../../src/crawler") as Record<string, unknown>;
  for (const name of [
    "CRAWL_PAGE_ERROR_CODES",
    "CRAWL_PAGE_TIMEOUT_MILLISECONDS",
    "CrawlPageError",
    "MAX_CRAWL_BODY_BYTES",
    "MAX_CRAWL_REDIRECTS",
    "fetchCrawlPage",
    "CRAWL_EVIDENCE_ERROR_CODES",
    "CrawlEvidenceError",
    "collectSinglePageCrawlEvidence",
  ]) {
    assert.notEqual(crawler[name], undefined, name);
  }
  assert.equal(typeof crawler.collectSinglePageCrawlEvidence, "function");
  assert.equal((crawler.collectSinglePageCrawlEvidence as (...args: unknown[]) => unknown).length, 2);
  assert.deepEqual(crawler.CRAWL_EVIDENCE_ERROR_CODES, ["INVALID_REQUEST"]);
  assert.equal(Object.prototype.hasOwnProperty.call(crawler, "collectSinglePageCrawlEvidenceWithDependencies"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(crawler, "CrawlPageFetcher"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(crawler, "SinglePageCrawlDependencies"), false);

  const index = readFileSync(join(process.cwd(), "src/crawler/index.ts"), "utf8");
  assert.equal(index.includes("collectSinglePageCrawlEvidenceWithDependencies"), false);
  assert.equal(index.includes("CrawlPageFetcher"), false);
  assert.equal(index.includes("SinglePageCrawlDependencies"), false);
  assert.match(index, /\bcollectSinglePageCrawlEvidence\b/);

  const evidence = readFileSync(join(process.cwd(), "src/crawler/single-page-evidence.ts"), "utf8");
  assert.match(evidence, /fetchPage:\s*fetchCrawlPage/);
  assert.match(evidence, /import type \{ BusinessLead \} from "\.\.\/leads\/domain"/);
  assert.match(evidence, /from "\.\.\/network-safety\/errors"/);
  assert.equal(/from ["']\.\.\/network-safety["']/.test(evidence), false);
  assert.equal(/from ["']\.\.\/leads["']/.test(evidence), false);
  for (const token of [
    "isBusinessLeadId",
    "normalizeWebsiteUrl",
    "normalizeNetworkUrl",
    "validateExpectedVersion",
    "DoNotContactService",
    "LeadService",
    "src/compliance",
    "src/db",
    "src/audit",
    "src/config",
    "src/discovery",
    "node:http",
    "node:https",
    "node:net",
    "node-transport",
    "resolveSafeTarget",
    "resolveSafeRedirect",
    "createNodeDnsResolver",
    "undici",
    "better-sqlite3",
  ]) {
    assert.equal(evidence.includes(token), false, token);
  }
  assert.equal(/\bfetch\s*\(/.test(evidence), false);
});
