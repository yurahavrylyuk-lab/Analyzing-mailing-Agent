import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Database } from "../../src/db";
import { createBusinessLead, type BusinessLead } from "../../src/leads/domain";
import { LeadPersistenceError } from "../../src/leads/errors";
import type { StoredSinglePageCrawlEvidence } from "../../src/crawler/evidence-domain";
import {
  CrawlRunError,
  runBoundedSinglePageCrawl,
  selectCandidates,
  type SinglePageCrawlRunRequest,
  type SinglePageCrawlRunResult,
} from "../../src/crawler/run";
import {
  runBoundedSinglePageCrawlWithDependencies,
  type SinglePageCrawlRunDependencies,
} from "../../src/crawler/run-loop";
import type {
  CrawlEvidenceFailureCode,
  FailedCrawlEvidence,
  FetchedCrawlEvidence,
  SinglePageCrawlEvidence,
} from "../../src/crawler/single-page-evidence";

const MARKER_URL = "https://marker.example/secret-page";
const MARKER_HTML = "<html>secret-body-marker</html>";
const MARKER_NAME = "Secret Business Marker";
const ID_A = "00000000-0000-4000-8000-0000000000a1";
const ID_B = "00000000-0000-4000-8000-0000000000b2";
const ATTEMPTED_AT = "2026-10-21T12:00:00.000Z";

function snapshot(id: string, url = MARKER_URL): BusinessLead {
  return createBusinessLead(
    {
      businessName: MARKER_NAME,
      sourceKind: "manual",
      sourceReference: `ref-${id}`,
      websiteObservation: { presence: "present", url },
    },
    id,
    new Date("2026-04-01T00:00:00.000Z"),
  );
}

function presentUrl(lead: BusinessLead): string {
  const observation = lead.websiteObservation;
  if (observation.presence !== "present") {
    throw new Error("Expected a present website.");
  }
  return observation.url;
}

function fetched(lead: BusinessLead): FetchedCrawlEvidence {
  return Object.freeze({
    outcome: "fetched",
    leadId: lead.id,
    leadVersion: lead.version,
    requestedUrl: presentUrl(lead),
    finalUrl: presentUrl(lead),
    statusCode: 200,
    contentType: "text/html",
    bodyText: MARKER_HTML,
    byteLength: Buffer.byteLength(MARKER_HTML, "utf8"),
    redirectCount: 0,
    attemptedAt: ATTEMPTED_AT,
  });
}

function failed(lead: BusinessLead, failure: CrawlEvidenceFailureCode): FailedCrawlEvidence {
  return Object.freeze({
    outcome: "failed",
    leadId: lead.id,
    leadVersion: lead.version,
    requestedUrl: presentUrl(lead),
    failure,
    attemptedAt: ATTEMPTED_AT,
  });
}

function stored(evidence: SinglePageCrawlEvidence): StoredSinglePageCrawlEvidence {
  if (evidence.outcome === "fetched") {
    return Object.freeze({ ...evidence, id: 1 });
  }
  return Object.freeze({ ...evidence, id: 1 });
}

function openSignal(): AbortSignal {
  return new AbortController().signal;
}

function request(maxAttempts: number, signal: AbortSignal = openSignal()): SinglePageCrawlRunRequest {
  return { maxAttempts, signal };
}

function unusedDatabase(): Database {
  const fail = (): never => {
    throw new Error("database used");
  };
  return {
    exec: fail,
    run: fail,
    get: fail,
    all: fail,
    transaction: fail,
    close: fail,
  };
}

function selectorDatabase(allRows: () => unknown, loadRow: () => unknown = () => undefined): Database {
  const base = unusedDatabase();
  return {
    ...base,
    all<T>(): T[] {
      return allRows() as T[];
    },
    get<T>(): T | undefined {
      return loadRow() as T | undefined;
    },
    transaction<T>(operation: () => T): T {
      return operation();
    },
  };
}

function assertInvariants(result: SinglePageCrawlRunResult, maxAttempts: number): void {
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.summary), true);
  assert.equal(Object.isFrozen(result.stop), true);
  assert.deepEqual(Object.keys(result).sort(), ["stop", "summary"]);
  assert.deepEqual(Object.keys(result.summary).sort(), [
    "attempted",
    "failed",
    "fetched",
    "persisted",
    "selected",
  ]);
  assert.deepEqual(Object.keys(result.stop).sort(), ["reason", "status"]);
  const { summary } = result;
  assert.equal(summary.selected >= 0 && summary.selected <= maxAttempts, true);
  assert.equal(summary.attempted >= 0 && summary.attempted <= summary.selected, true);
  assert.equal(summary.persisted, summary.attempted);
  assert.equal(summary.fetched + summary.failed, summary.attempted);
  assert.equal(summary.fetched >= 0, true);
  assert.equal(summary.failed >= 0, true);
  assert.equal(Number.isSafeInteger(summary.selected), true);
  assert.equal(Number.isSafeInteger(summary.attempted), true);
  assert.equal(Number.isSafeInteger(summary.fetched), true);
  assert.equal(Number.isSafeInteger(summary.failed), true);
  assert.equal(Number.isSafeInteger(summary.persisted), true);
  const text = JSON.stringify(result);
  assert.equal(text.includes(MARKER_URL), false);
  assert.equal(text.includes(MARKER_HTML), false);
  assert.equal(text.includes(MARKER_NAME), false);
  assert.equal(text.includes(ID_A), false);
  assert.equal(text.includes(ID_B), false);
}

function assertInvalid(error: unknown): boolean {
  assert.ok(error instanceof CrawlRunError);
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(error.name, "CrawlRunError");
  assert.equal(error.message, "Crawl run request is invalid.");
  assert.equal(error.cause, undefined);
  return true;
}

function assertSelectionFailed(error: unknown, hidden: readonly string[]): boolean {
  assert.ok(error instanceof CrawlRunError);
  assert.equal(error instanceof LeadPersistenceError, false);
  assert.equal(error.code, "SELECTION_FAILED");
  assert.equal(error.name, "CrawlRunError");
  assert.equal(error.message, "Crawl candidate selection failed.");
  assert.equal(error.cause, undefined);
  for (const value of hidden) {
    assert.equal(error.message.includes(value), false, value);
  }
  return true;
}

async function runWith(
  maxAttempts: number,
  dependencies: SinglePageCrawlRunDependencies,
  signal: AbortSignal = openSignal(),
): Promise<SinglePageCrawlRunResult> {
  return runBoundedSinglePageCrawlWithDependencies(
    request(maxAttempts, signal),
    dependencies,
  );
}

test("rejects an invalid budget or signal before selection", async () => {
  const cases: ReadonlyArray<Readonly<{ maxAttempts: number; signal: unknown }>> = [
    { maxAttempts: 0, signal: openSignal() },
    { maxAttempts: 61, signal: openSignal() },
    { maxAttempts: 1.5, signal: openSignal() },
    { maxAttempts: Number.MAX_SAFE_INTEGER + 1, signal: openSignal() },
    { maxAttempts: 1, signal: {} },
    { maxAttempts: 1, signal: new AbortController() },
    { maxAttempts: 1, signal: undefined },
  ];

  for (const [index, entry] of cases.entries()) {
    let selected = 0;
    await assert.rejects(
      () => runBoundedSinglePageCrawlWithDependencies(
        { maxAttempts: entry.maxAttempts, signal: entry.signal as AbortSignal },
        {
          select: () => {
            selected += 1;
            return [];
          },
          collect: async () => {
            throw new Error("collect called");
          },
          persist: () => {
            throw new Error("persist called");
          },
        },
      ),
      assertInvalid,
      `case ${index}`,
    );
    assert.equal(selected, 0, `case ${index} selected`);
  }
});

test("accepts attempt budgets of 1 and 60", async () => {
  for (const maxAttempts of [1, 60]) {
    let selected = 0;
    const result = await runWith(maxAttempts, {
      select: (budget) => {
        selected += 1;
        assert.equal(budget, maxAttempts);
        return [];
      },
      collect: async () => {
        throw new Error("collect called");
      },
      persist: () => {
        throw new Error("persist called");
      },
    });
    assert.equal(selected, 1);
    assert.deepEqual(result.summary, {
      selected: 0,
      attempted: 0,
      fetched: 0,
      failed: 0,
      persisted: 0,
    });
    assert.deepEqual(result.stop, { status: "completed", reason: "candidates_exhausted" });
    assertInvariants(result, maxAttempts);
  }
});

test("returns a cancelled zero summary when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let selected = 0;
  const result = await runWith(4, {
    select: () => {
      selected += 1;
      return [snapshot(ID_A)];
    },
    collect: async () => {
      throw new Error("collect called");
    },
    persist: () => {
      throw new Error("persist called");
    },
  }, controller.signal);
  assert.equal(selected, 0);
  assert.deepEqual(result.summary, {
    selected: 0,
    attempted: 0,
    fetched: 0,
    failed: 0,
    persisted: 0,
  });
  assert.deepEqual(result.stop, { status: "cancelled", reason: "cancelled" });
  assertInvariants(result, 4);
});

test("returns candidates_exhausted without collection when nothing is selected", async () => {
  let collects = 0;
  let persists = 0;
  const result = await runWith(5, {
    select: () => [],
    collect: async () => {
      collects += 1;
      throw new Error("collect called");
    },
    persist: () => {
      persists += 1;
      throw new Error("persist called");
    },
  });
  assert.equal(collects, 0);
  assert.equal(persists, 0);
  assert.equal(result.summary.selected, 0);
  assert.deepEqual(result.stop, { status: "completed", reason: "candidates_exhausted" });
  assertInvariants(result, 5);
});

test("returns candidates_exhausted when the selector returns fewer than maxAttempts", async () => {
  const result = await runWith(4, {
    select: () => [snapshot(ID_A)],
    collect: async (lead) => fetched(lead),
    persist: (evidence) => stored(evidence),
  });
  assert.equal(result.summary.selected, 1);
  assert.equal(result.summary.attempted, 1);
  assert.deepEqual(result.stop, { status: "completed", reason: "candidates_exhausted" });
  assertInvariants(result, 4);
});

test("returns budget_exhausted when the selector returns maxAttempts", async () => {
  let selections = 0;
  const result = await runWith(2, {
    select: (maxAttempts) => {
      selections += 1;
      assert.equal(maxAttempts, 2);
      return [snapshot(ID_A), snapshot(ID_B)];
    },
    collect: async (lead) => fetched(lead),
    persist: (evidence) => stored(evidence),
  });
  assert.equal(selections, 1);
  assert.equal(result.summary.selected, 2);
  assert.equal(result.summary.attempted, 2);
  assert.equal(result.summary.persisted, 2);
  assert.deepEqual(result.stop, { status: "completed", reason: "budget_exhausted" });
  assertInvariants(result, 2);
});

test("persists one fetched attempt and increments fetched", async () => {
  let collects = 0;
  let persists = 0;
  const lead = snapshot(ID_A);
  let returned: SinglePageCrawlEvidence | undefined;
  const result = await runWith(3, {
    select: () => [lead],
    collect: async (candidate) => {
      collects += 1;
      assert.equal(candidate, lead);
      returned = fetched(candidate);
      return returned;
    },
    persist: (evidence) => {
      persists += 1;
      assert.equal(evidence, returned);
      return stored(evidence);
    },
  });
  assert.equal(collects, 1);
  assert.equal(persists, 1);
  assert.equal(result.summary.fetched, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.attempted, 1);
  assert.equal(result.summary.persisted, 1);
  assert.deepEqual(result.stop, { status: "completed", reason: "candidates_exhausted" });
  assertInvariants(result, 3);
});

test("persists a normal failure and continues with the next candidate", async () => {
  const leads = [snapshot(ID_A), snapshot(ID_B)];
  const collected: string[] = [];
  const persisted: SinglePageCrawlEvidence[] = [];
  let selections = 0;
  const result = await runWith(4, {
    select: () => {
      selections += 1;
      return leads;
    },
    collect: async (lead) => {
      collected.push(lead.id);
      return lead.id === ID_A ? failed(lead, "TIMEOUT") : fetched(lead);
    },
    persist: (evidence) => {
      persisted.push(evidence);
      return stored(evidence);
    },
  });
  assert.equal(selections, 1);
  assert.deepEqual(collected, [ID_A, ID_B]);
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0]?.outcome, "failed");
  assert.equal(persisted[1]?.outcome, "fetched");
  assert.equal(result.summary.selected, 2);
  assert.equal(result.summary.attempted, 2);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.fetched, 1);
  assert.equal(result.summary.persisted, 2);
  assert.deepEqual(result.stop, { status: "completed", reason: "candidates_exhausted" });
  assertInvariants(result, 4);
});

test("persists cancelled evidence, counts it as failed, and does not start the next lead", async () => {
  const controller = new AbortController();
  const collected: string[] = [];
  const persisted: SinglePageCrawlEvidence[] = [];
  const result = await runWith(3, {
    select: () => [snapshot(ID_A), snapshot(ID_B)],
    collect: async (lead) => {
      collected.push(lead.id);
      return failed(lead, "CANCELLED");
    },
    persist: (evidence) => {
      persisted.push(evidence);
      assert.equal(evidence.outcome, "failed");
      if (evidence.outcome === "failed") {
        assert.equal(evidence.failure, "CANCELLED");
      }
      return stored(evidence);
    },
  }, controller.signal);
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(collected, [ID_A]);
  assert.equal(persisted.length, 1);
  assert.equal(result.summary.selected, 2);
  assert.equal(result.summary.attempted, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.fetched, 0);
  assert.equal(result.summary.persisted, 1);
  assert.deepEqual(result.stop, { status: "cancelled", reason: "cancelled" });
  assertInvariants(result, 3);
});

test("collects and persists candidates one at a time", async () => {
  const events: string[] = [];
  const seen = new Map<string, number>();
  let active = 0;
  const returned = new Map<string, SinglePageCrawlEvidence>();
  const result = await runWith(2, {
    select: () => [snapshot(ID_A), snapshot(ID_B)],
    collect: async (lead) => {
      assert.equal(active, 0);
      active += 1;
      seen.set(lead.id, (seen.get(lead.id) ?? 0) + 1);
      events.push(`collect:${lead.id}`);
      await Promise.resolve();
      assert.equal(active, 1);
      active -= 1;
      const evidence = lead.id === ID_A ? fetched(lead) : failed(lead, "HTTP_FAILURE");
      returned.set(lead.id, evidence);
      return evidence;
    },
    persist: (evidence) => {
      assert.equal(active, 0);
      assert.equal(evidence, returned.get(evidence.leadId));
      events.push(`persist:${evidence.leadId}:${evidence.outcome}`);
      return stored(evidence);
    },
  });
  assert.deepEqual(events, [
    `collect:${ID_A}`,
    `persist:${ID_A}:fetched`,
    `collect:${ID_B}`,
    `persist:${ID_B}:failed`,
  ]);
  assert.equal(seen.get(ID_A), 1);
  assert.equal(seen.get(ID_B), 1);
  assert.equal(result.summary.fetched, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.attempted, 2);
  assert.deepEqual(result.stop, { status: "completed", reason: "budget_exhausted" });
  assertInvariants(result, 2);
});

test("does not collect the next lead when the signal aborts after a persist", async () => {
  const controller = new AbortController();
  const collected: string[] = [];
  const persisted: string[] = [];
  const result = await runWith(2, {
    select: () => [snapshot(ID_A), snapshot(ID_B)],
    collect: async (lead) => {
      collected.push(lead.id);
      return fetched(lead);
    },
    persist: (evidence) => {
      persisted.push(evidence.leadId);
      controller.abort();
      return stored(evidence);
    },
  }, controller.signal);
  assert.deepEqual(collected, [ID_A]);
  assert.deepEqual(persisted, [ID_A]);
  assert.equal(result.summary.selected, 2);
  assert.equal(result.summary.attempted, 1);
  assert.equal(result.summary.fetched, 1);
  assert.equal(result.summary.persisted, 1);
  assert.deepEqual(result.stop, { status: "cancelled", reason: "cancelled" });
  assertInvariants(result, 2);
});

test("persists a fetched result that lands after the signal aborts, then cancels", async () => {
  const controller = new AbortController();
  const collected: string[] = [];
  let persisted = 0;
  const result = await runWith(2, {
    select: () => [snapshot(ID_A), snapshot(ID_B)],
    collect: async (lead) => {
      collected.push(lead.id);
      controller.abort();
      return fetched(lead);
    },
    persist: (evidence) => {
      assert.equal(controller.signal.aborted, true);
      assert.equal(evidence.outcome, "fetched");
      persisted += 1;
      return stored(evidence);
    },
  }, controller.signal);
  assert.deepEqual(collected, [ID_A]);
  assert.equal(persisted, 1);
  assert.equal(result.summary.fetched, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.attempted, 1);
  assert.deepEqual(result.stop, { status: "cancelled", reason: "cancelled" });
  assertInvariants(result, 2);
});

test("persists a non-cancelled failure that lands after the signal aborts, then cancels", async () => {
  const controller = new AbortController();
  const collected: string[] = [];
  let persisted = 0;
  const result = await runWith(2, {
    select: () => [snapshot(ID_A), snapshot(ID_B)],
    collect: async (lead) => {
      collected.push(lead.id);
      controller.abort();
      return failed(lead, "NETWORK_FAILURE");
    },
    persist: (evidence) => {
      assert.equal(controller.signal.aborted, true);
      persisted += 1;
      return stored(evidence);
    },
  }, controller.signal);
  assert.deepEqual(collected, [ID_A]);
  assert.equal(persisted, 1);
  assert.equal(result.summary.fetched, 0);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.attempted, 1);
  assert.deepEqual(result.stop, { status: "cancelled", reason: "cancelled" });
  assertInvariants(result, 2);
});

test("propagates a collector failure without persisting or continuing", async () => {
  const clockError = new TypeError("clock failed");
  const collected: string[] = [];
  let persists = 0;
  await assert.rejects(
    () => runWith(2, {
      select: () => [snapshot(ID_A), snapshot(ID_B)],
      collect: async (lead) => {
        collected.push(lead.id);
        throw clockError;
      },
      persist: () => {
        persists += 1;
        throw new Error("persist called");
      },
    }),
    (error: unknown) => {
      assert.equal(error, clockError);
      return true;
    },
  );
  assert.deepEqual(collected, [ID_A]);
  assert.equal(persists, 0);
});

test("propagates a persist failure without retrying or continuing", async () => {
  const writeError = new Error("write failed");
  const collected: string[] = [];
  let persists = 0;
  await assert.rejects(
    () => runWith(2, {
      select: () => [snapshot(ID_A), snapshot(ID_B)],
      collect: async (lead) => {
        collected.push(lead.id);
        return fetched(lead);
      },
      persist: (evidence) => {
        persists += 1;
        assert.equal(evidence.leadId, ID_A);
        throw writeError;
      },
    }),
    (error: unknown) => {
      assert.equal(error, writeError);
      return true;
    },
  );
  assert.deepEqual(collected, [ID_A]);
  assert.equal(persists, 1);
});

test("hides selector sqlite failures and leaves programming errors visible", async () => {
  const hidden = "secret-marker SELECT business_leads SQLITE_ERROR";
  class SqliteError extends Error {
    readonly name = "SqliteError";

    constructor() {
      super(hidden);
    }
  }

  const noWork = {
    collect: async (): Promise<SinglePageCrawlEvidence> => {
      throw new Error("collect called");
    },
    persist: (): StoredSinglePageCrawlEvidence => {
      throw new Error("persist called");
    },
  };
  await assert.rejects(
    () => runBoundedSinglePageCrawlWithDependencies(
      request(1),
      {
        ...noWork,
        select: (maxAttempts) => selectCandidates(selectorDatabase(() => {
          throw new SqliteError();
        }), maxAttempts),
      },
    ),
    (error: unknown) => assertSelectionFailed(error, ["secret-marker", "SELECT", "business_leads", "SQLITE"]),
  );

  await assert.rejects(
    () => runBoundedSinglePageCrawlWithDependencies(
      request(1),
      {
        ...noWork,
        select: (maxAttempts) => selectCandidates(selectorDatabase(
          () => [{ id: ID_A }, { id: ID_B }],
          () => {
            throw new Error("findById called");
          },
        ), maxAttempts),
      },
    ),
    (error: unknown) => assertSelectionFailed(error, ["findById"]),
  );

  await assert.rejects(
    () => runBoundedSinglePageCrawlWithDependencies(
      request(1),
      {
        ...noWork,
        select: (maxAttempts) => selectCandidates(
          selectorDatabase(() => [{ id: ID_A }], () => undefined),
          maxAttempts,
        ),
      },
    ),
    (error: unknown) => assertSelectionFailed(error, [ID_A, MARKER_URL]),
  );

  const programming = new TypeError("programming-marker");
  await assert.rejects(
    () => runBoundedSinglePageCrawlWithDependencies(
      request(1),
      {
        ...noWork,
        select: (maxAttempts) => selectCandidates(selectorDatabase(() => {
          throw programming;
        }), maxAttempts),
      },
    ),
    (error: unknown) => {
      assert.equal(error, programming);
      assert.equal(error instanceof CrawlRunError, false);
      return true;
    },
  );
});

test("propagates a lead mapping failure from candidate loading", async () => {
  await assert.rejects(
    () => runBoundedSinglePageCrawlWithDependencies(
      request(1),
      {
        select: (maxAttempts) => selectCandidates(
          selectorDatabase(
            () => [{ id: ID_A }],
            () => ({
              id: ID_A,
              business_name: MARKER_NAME,
              source_kind: "manual",
              source_provider: null,
              source_reference: "ref",
              status: "recorded",
              website_presence: "present",
              website_url: "https://user:pass@example.com/secret",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              version: 1,
            }),
          ),
          maxAttempts,
        ),
        collect: async () => {
          throw new Error("collect called");
        },
        persist: () => {
          throw new Error("persist called");
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof LeadPersistenceError);
      assert.equal(error instanceof CrawlRunError, false);
      assert.equal(error.message, "Lead persistence operation failed.");
      assert.equal(error.message.includes("user:pass"), false);
      assert.equal(error.message.includes("example.com"), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("production entry cancels before touching the database when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const database = new Proxy({} as Database, {
    get: () => () => {
      throw new Error("database used");
    },
  });
  const result = await runBoundedSinglePageCrawl(database, request(2, controller.signal));
  assert.deepEqual(result.summary, {
    selected: 0,
    attempted: 0,
    fetched: 0,
    failed: 0,
    persisted: 0,
  });
  assert.deepEqual(result.stop, { status: "cancelled", reason: "cancelled" });
  assertInvariants(result, 2);
});

test("awaits an async select once before collection", async () => {
  let selected = 0;
  let collects = 0;
  const result = await runWith(2, {
    select: async (maxAttempts) => {
      selected += 1;
      assert.equal(maxAttempts, 2);
      assert.equal(collects, 0);
      await Promise.resolve();
      return [snapshot(ID_A)];
    },
    collect: async (lead) => {
      collects += 1;
      assert.equal(selected, 1);
      return fetched(lead);
    },
    persist: (evidence) => stored(evidence),
  });
  assert.equal(selected, 1);
  assert.equal(collects, 1);
  assert.equal(result.summary.selected, 1);
  assert.equal(result.summary.attempted, 1);
  assert.equal(result.summary.persisted, 1);
  assert.deepEqual(result.stop, { status: "completed", reason: "candidates_exhausted" });
  assertInvariants(result, 2);
});

test("awaits persist before collecting the next candidate", async () => {
  const order: string[] = [];
  const result = await runWith(2, {
    select: async () => {
      order.push("select");
      return [snapshot(ID_A), snapshot(ID_B)];
    },
    collect: async (lead) => {
      order.push(`collect:${lead.id}`);
      return fetched(lead);
    },
    persist: async (evidence) => {
      order.push(`persist:${evidence.leadId}`);
      await Promise.resolve();
      order.push(`persisted:${evidence.leadId}`);
      return stored(evidence);
    },
  });
  assert.deepEqual(order, [
    "select",
    `collect:${ID_A}`,
    `persist:${ID_A}`,
    `persisted:${ID_A}`,
    `collect:${ID_B}`,
    `persist:${ID_B}`,
    `persisted:${ID_B}`,
  ]);
  assert.equal(result.summary.attempted, 2);
  assert.equal(result.summary.persisted, 2);
  assert.deepEqual(result.stop, { status: "completed", reason: "budget_exhausted" });
  assertInvariants(result, 2);
});

test("accepts synchronous select and persist callbacks", async () => {
  const result = await runWith(1, {
    select: () => [snapshot(ID_A)],
    collect: async (lead) => failed(lead, "TIMEOUT"),
    persist: (evidence) => stored(evidence),
  });
  assert.equal(result.summary.selected, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.fetched, 0);
  assert.equal(result.summary.persisted, 1);
  assert.deepEqual(result.stop, { status: "completed", reason: "budget_exhausted" });
  assertInvariants(result, 1);
});

test("keeps the dependency seam off the public crawler entry", () => {
  const crawler = require("../../src/crawler") as Record<string, unknown>;
  assert.equal(typeof crawler.runBoundedSinglePageCrawl, "function");
  assert.equal(typeof crawler.CrawlRunError, "function");
  assert.equal(Object.prototype.hasOwnProperty.call(crawler, "runBoundedSinglePageCrawlWithDependencies"), false);
  assert.equal(crawler.runBoundedSinglePageCrawlWithDependencies, undefined);

  const index = readFileSync(join(process.cwd(), "src/crawler/index.ts"), "utf8");
  assert.equal(index.includes("runBoundedSinglePageCrawlWithDependencies"), false);
  assert.equal(index.includes("selectCandidates"), false);
  assert.equal(index.includes("SinglePageCrawlRunDependencies"), false);
  assert.match(index, /\brunBoundedSinglePageCrawl\b/);
  assert.match(index, /\bCrawlRunError\b/);

  const loop = readFileSync(join(process.cwd(), "src/crawler/run-loop.ts"), "utf8");
  assert.match(loop, /export async function runBoundedSinglePageCrawlWithDependencies/);
  assert.equal(loop.includes("selectCandidates"), false);
  for (const token of ["Database", "better-sqlite3", "fetchCrawlPage", "D1", "miniflare"]) {
    assert.equal(loop.includes(token), false, token);
  }

  const source = readFileSync(join(process.cwd(), "src/crawler/run.ts"), "utf8");
  assert.equal(source.includes("export async function runBoundedSinglePageCrawlWithDependencies"), false);
  assert.match(source, /export function selectCandidates/);
  assert.match(source, /function selectCandidates/);
  assert.equal(source.includes("LIMIT ?"), true);
  assert.equal(source.includes("LIMIT ${"), false);
  assert.equal(source.includes("outcome = 'fetched'"), false);
  assert.equal(source.includes("failure_code <> 'CANCELLED'"), false);
  const filter = readFileSync(join(process.cwd(), "src/crawler/candidate-filter.ts"), "utf8");
  assert.equal(filter.includes("outcome = 'fetched'"), true);
  assert.equal(filter.includes("failure_code <> 'CANCELLED'"), true);
  for (const token of [
    "../compliance",
    "../discovery",
    "./fetch-page",
    "fetchCrawlPage",
    "../network-safety",
    "DoNotContactService",
    "Promise.all",
  ]) {
    assert.equal(source.includes(token), false, token);
  }
});
