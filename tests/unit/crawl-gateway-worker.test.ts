import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  handleCrawlGatewayRequest,
  type CrawlGatewayEnv,
} from "../../src/crawl-gateway/worker";
import type { D1CrawlDatabase } from "../../src/crawler/d1-crawl-store";

const TOKEN = "gateway-token-do-not-reflect";
const HTML_SENTINEL = "<p>html-sentinel</p>";
const LEAD_ID = "00000000-0000-4000-8000-000000000001";
const SELECT_URL = "https://gateway.example/internal/crawl/select";
const EVIDENCE_URL = "https://gateway.example/internal/crawl/evidence";

const manualRow = {
  id: LEAD_ID,
  business_name: "Distinctive Business Name",
  source_kind: "manual",
  source_provider: null,
  source_reference: "ref-distinctive",
  status: "recorded",
  website_presence: "present",
  website_url: "https://example.com/",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  version: 3,
};

const manualLead = {
  id: LEAD_ID,
  businessName: "Distinctive Business Name",
  sourceReference: "ref-distinctive",
  status: "recorded",
  websiteObservation: { presence: "present", url: "https://example.com/" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  version: 3,
  sourceKind: "manual",
};

type StatementResult = {
  all?: () => Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  first?: () => Promise<Record<string, unknown> | null>;
  run?: () => Promise<{
    readonly meta: { readonly changes: number; readonly last_row_id: number };
  }>;
};

function createDatabase(behavior: StatementResult = {}): {
  database: D1CrawlDatabase;
  prepareCount(): number;
} {
  let prepares = 0;
  const database: D1CrawlDatabase = {
    prepare() {
      prepares += 1;
      const statement = {
        bind() {
          return statement;
        },
        all() {
          if (behavior.all === undefined) {
            return Promise.reject(new Error("unexpected all"));
          }
          return behavior.all();
        },
        first() {
          if (behavior.first === undefined) {
            return Promise.reject(new Error("unexpected first"));
          }
          return behavior.first();
        },
        run() {
          if (behavior.run === undefined) {
            return Promise.reject(new Error("unexpected run"));
          }
          return behavior.run();
        },
      };
      return statement;
    },
  };
  return {
    database,
    prepareCount() {
      return prepares;
    },
  };
}

function gatewayEnv(database: D1CrawlDatabase, token?: string): CrawlGatewayEnv {
  if (arguments.length < 2) {
    return { DB: database, CRAWL_GATEWAY_TOKEN: TOKEN };
  }
  return { DB: database, CRAWL_GATEWAY_TOKEN: token };
}

function fetchedEvidence() {
  return {
    outcome: "fetched" as const,
    leadId: LEAD_ID,
    leadVersion: 1,
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    statusCode: 200,
    contentType: "text/html" as const,
    bodyText: HTML_SENTINEL,
    byteLength: Buffer.byteLength(HTML_SENTINEL, "utf8"),
    redirectCount: 0,
    attemptedAt: "2026-10-22T00:00:00.000Z",
  };
}

function storedFetchedRow() {
  const evidence = fetchedEvidence();
  return {
    id: 1,
    lead_id: evidence.leadId,
    lead_version: evidence.leadVersion,
    outcome: "fetched",
    requested_url: evidence.requestedUrl,
    attempted_at: evidence.attemptedAt,
    final_url: evidence.finalUrl,
    status_code: evidence.statusCode,
    content_type: evidence.contentType,
    body_text: evidence.bodyText,
    byte_length: evidence.byteLength,
    redirect_count: evidence.redirectCount,
    failure_code: null,
  };
}

async function readResponse(response: Response): Promise<{
  status: number;
  text: string;
  body: unknown;
}> {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

async function expectNoConsole(run: () => Promise<void>): Promise<void> {
  const calls: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {
    calls.push("log");
  };
  console.info = () => {
    calls.push("info");
  };
  console.warn = () => {
    calls.push("warn");
  };
  console.error = () => {
    calls.push("error");
  };
  try {
    await run();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  assert.deepEqual(calls, []);
}

test("missing bearer returns 401 and does not call D1", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(SELECT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxAttempts: 1 }),
      }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.text, '{"error":"unauthorized"}');
  assert.equal(prepareCount(), 0);
});

test("wrong bearer returns 401 and does not call D1", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(SELECT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ maxAttempts: 1 }),
      }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.text, '{"error":"unauthorized"}');
  assert.equal(prepareCount(), 0);
  assert.equal(response.text.includes(TOKEN), false);
  assert.equal(response.text.includes("wrong-token"), false);
});

test("lowercase bearer scheme returns 401", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(SELECT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `bearer ${TOKEN}`,
        },
        body: JSON.stringify({ maxAttempts: 1 }),
      }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.text, '{"error":"unauthorized"}');
  assert.equal(prepareCount(), 0);
});

test("unset worker secret returns 401", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(SELECT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ maxAttempts: 1 }),
      }),
      gatewayEnv(database, undefined),
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.text, '{"error":"unauthorized"}');
  assert.equal(prepareCount(), 0);
});

test("missing bearer does not read the body or call D1", async () => {
  const { database, prepareCount } = createDatabase();
  const request = new Request(SELECT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxAttempts: 1 }),
  });
  request.text = () => {
    throw new Error("body-was-read");
  };

  const response = await readResponse(
    await handleCrawlGatewayRequest(request, gatewayEnv(database)),
  );

  assert.equal(response.status, 401);
  assert.equal(response.text, '{"error":"unauthorized"}');
  assert.equal(prepareCount(), 0);
});

test("unknown route returns 404", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request("https://gateway.example/internal/other", { method: "POST" }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 404);
  assert.equal(response.text, '{"error":"not_found"}');
  assert.equal(prepareCount(), 0);
});

test("select path with a query returns 404", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(`${SELECT_URL}?x=1`, { method: "POST" }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 404);
  assert.equal(prepareCount(), 0);
});

test("trailing slash returns 404", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(`${SELECT_URL}/`, { method: "POST" }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 404);
  assert.equal(response.text, '{"error":"not_found"}');
  assert.equal(prepareCount(), 0);
});

test("wrong method returns 405", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(SELECT_URL, { method: "GET" }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 405);
  assert.equal(response.text, '{"error":"method_not_allowed"}');
  assert.equal(prepareCount(), 0);
});

test("malformed select returns 400", async () => {
  const bodies = [
    { maxAttempts: 1, extra: true },
    { maxAttempts: "10" },
    { maxAttempts: 0 },
    { maxAttempts: 61 },
    { maxAttempts: 1.5 },
  ];

  for (const body of bodies) {
    const { database, prepareCount } = createDatabase();
    const response = await readResponse(
      await handleCrawlGatewayRequest(
        new Request(SELECT_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify(body),
        }),
        gatewayEnv(database),
      ),
    );

    assert.equal(response.status, 400);
    assert.equal(response.text, '{"error":"invalid_request"}');
    assert.equal(prepareCount(), 0);
  }
});

test("missing content type returns 400", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(SELECT_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 400);
  assert.equal(response.text, '{"error":"invalid_request"}');
  assert.equal(prepareCount(), 0);
});

test("oversized body returns 400 and does not call D1", async () => {
  const { database, prepareCount } = createDatabase();
  let textCalled = false;
  const request = new Request(SELECT_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "content-length": "3145729",
    },
    body: JSON.stringify({ maxAttempts: 1 }),
  });
  request.text = async () => {
    textCalled = true;
    return JSON.stringify({ maxAttempts: 1 });
  };

  const response = await readResponse(
    await handleCrawlGatewayRequest(request, gatewayEnv(database)),
  );

  assert.equal(response.status, 400);
  assert.equal(response.text, '{"error":"invalid_request"}');
  assert.equal(prepareCount(), 0);
  assert.equal(textCalled, false);
});

test("json charset is accepted", async () => {
  const { database, prepareCount } = createDatabase({
    all: async () => ({ results: [] }),
  });
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(SELECT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ maxAttempts: 1 }),
      }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(prepareCount() > 0, true);
});

test("valid bearer select returns the full BusinessLead snapshot", async () => {
  const { database, prepareCount } = createDatabase({
    all: async () => ({ results: [manualRow] }),
  });

  await expectNoConsole(async () => {
    const response = await readResponse(
      await handleCrawlGatewayRequest(
        new Request(SELECT_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ maxAttempts: 1 }),
        }),
        gatewayEnv(database),
      ),
    );

    assert.equal(response.status, 200);
    assert.equal(prepareCount(), 1);
    const body = response.body as { candidates: unknown[] };
    assert.deepEqual(Object.keys(body), ["candidates"]);
    assert.equal(body.candidates.length, 1);
    assert.deepEqual(body.candidates[0], manualLead);
    assert.equal("sourceProvider" in (body.candidates[0] as object), false);
    assert.equal(response.text.includes("Distinctive Business Name"), true);
  });
});

test("empty select returns an empty candidate array", async () => {
  const { database } = createDatabase({
    all: async () => ({ results: [] }),
  });
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(SELECT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ maxAttempts: 10 }),
      }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { candidates: [] });
});

test("malformed evidence returns 400", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(EVIDENCE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ outcome: "fetched" }),
      }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 400);
  assert.equal(response.text, '{"error":"invalid_request"}');
  assert.equal(prepareCount(), 0);
});

test("lead not found returns 400", async () => {
  const { database } = createDatabase({
    first: async () => null,
  });
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(EVIDENCE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          outcome: "failed",
          leadId: LEAD_ID,
          leadVersion: 1,
          requestedUrl: "https://example.com/",
          failure: "TIMEOUT",
          attemptedAt: "2026-10-22T00:00:00.000Z",
        }),
      }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 400);
  assert.equal(response.text, '{"error":"invalid_request"}');
  assert.equal(response.text.includes(LEAD_ID), false);
});

test("valid evidence returns persisted true without html or id", async () => {
  const rows: Array<Record<string, unknown> | null> = [{ present: 1 }, storedFetchedRow()];
  const { database } = createDatabase({
    first: async () => {
      const next = rows.shift();
      return next === undefined ? null : next;
    },
    run: async () => ({ meta: { changes: 1, last_row_id: 1 } }),
  });
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(EVIDENCE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(fetchedEvidence()),
      }),
      gatewayEnv(database),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.text, '{"persisted":true}');
  assert.equal(response.text.includes("html-sentinel"), false);
  assert.equal(response.text.includes(LEAD_ID), false);
  assert.equal(response.text.includes(TOKEN), false);
});

test("selection and persistence failures stay fixed and do not reflect driver text html or the token", async () => {
  await expectNoConsole(async () => {
    const selection = createDatabase({
      all: async () => {
        throw new Error("D1_ERROR secret-sql");
      },
    });
    const selectionResponse = await readResponse(
      await handleCrawlGatewayRequest(
        new Request(SELECT_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ maxAttempts: 1 }),
        }),
        gatewayEnv(selection.database),
      ),
    );
    assert.equal(selectionResponse.status, 500);
    assert.equal(selectionResponse.text, '{"error":"internal_error"}');
    assert.equal(selectionResponse.text.includes("D1_ERROR"), false);
    assert.equal(selectionResponse.text.includes("secret-sql"), false);
    assert.equal(selectionResponse.text.includes(TOKEN), false);

    const persistence = createDatabase({
      first: async () => ({ present: 1 }),
      run: async () => {
        throw new Error("D1_ERROR secret-sql");
      },
    });
    const persistenceResponse = await readResponse(
      await handleCrawlGatewayRequest(
        new Request(EVIDENCE_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(fetchedEvidence()),
        }),
        gatewayEnv(persistence.database),
      ),
    );
    assert.equal(persistenceResponse.status, 500);
    assert.equal(persistenceResponse.text, '{"error":"internal_error"}');
    assert.equal(persistenceResponse.text.includes("html-sentinel"), false);
    assert.equal(persistenceResponse.text.includes("D1_ERROR"), false);
    assert.equal(persistenceResponse.text.includes("secret-sql"), false);
    assert.equal(persistenceResponse.text.includes(TOKEN), false);
  });
});

test("worker source does not import the crawl transport", () => {
  const source = readFileSync(join(process.cwd(), "src/crawl-gateway/worker.ts"), "utf8");
  assert.equal(source.includes("fetch-page"), false);
  assert.equal(source.includes("node-transport"), false);
  assert.equal(source.includes("node:http"), false);
  assert.equal(source.includes("node:https"), false);
  assert.equal(source.includes('from "../db"'), false);
  assert.equal(source.includes('from "../crawler/index"'), false);
  assert.equal(source.includes('from "../crawler/run"'), false);
  assert.equal(source.includes("selectD1CrawlCandidates"), true);
  assert.equal(source.includes("persistD1CrawlEvidence"), true);
  assert.equal(source.includes("timingSafeEqual"), true);
});
