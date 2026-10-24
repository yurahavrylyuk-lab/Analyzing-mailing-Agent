import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import worker, {
  handleCrawlGatewayRequest,
  type CrawlGatewayDatabase,
} from "../../src/crawl-gateway/worker";
import { runD1WebsiteAnalysisPipeline } from "../../src/website-analysis/d1-analysis-pipeline";
import { D1WebsiteAnalysisPipelineError } from "../../src/website-analysis/pipeline-errors";

const CRAWL_TOKEN = "crawl-token-do-not-reflect";
const ANALYSIS_TOKEN = "analysis-token-do-not-reflect";
const GEMINI_KEY = "gemini-key-do-not-reflect";
const ANALYSIS_URL = "https://gateway.example/internal/analysis/run";
const SELECT_URL = "https://gateway.example/internal/crawl/select";
function zeroSummaryText(): string {
  return JSON.stringify({
    selected: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    persisted: 0,
    budget: {
      utcDate: new Date().toISOString().slice(0, 10),
      websitesAdmitted: 0,
      websiteLimit: 50,
      geminiRequestsUsed: 0,
      geminiRequestLimit: 10,
      stoppedReason: "max_items",
    },
  });
}

type StatementResult = {
  all?: () => Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  first?: () => Promise<Record<string, unknown> | null>;
  run?: () => Promise<{
    readonly meta: { readonly changes: number; readonly last_row_id: number };
  }>;
};

function createDatabase(behavior: StatementResult = {}): {
  database: CrawlGatewayDatabase;
  prepareCount(): number;
} {
  let prepares = 0;
  const database: CrawlGatewayDatabase = {
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
    batch() {
      return Promise.reject(new Error("unused"));
    },
  };
  return {
    database,
    prepareCount() {
      return prepares;
    },
  };
}

function gatewayEnv(
  database: CrawlGatewayDatabase,
  fields: {
    readonly CRAWL_GATEWAY_TOKEN?: string;
    readonly ANALYSIS_GATEWAY_TOKEN?: string;
    readonly GEMINI_API_KEY?: string;
    readonly GEMINI_DAILY_REQUEST_LIMIT?: string;
  } = {},
) {
  return { DB: database, ...fields };
}

function assertNoSentinels(text: string): void {
  assert.equal(text.includes(CRAWL_TOKEN), false);
  assert.equal(text.includes(ANALYSIS_TOKEN), false);
  assert.equal(text.includes(GEMINI_KEY), false);
}

async function readResponse(response: Response): Promise<{
  status: number;
  text: string;
  body: unknown;
}> {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assertNoSentinels(text);
  return { status: response.status, text, body: JSON.parse(text) };
}

function analysisRequest(
  body: string,
  headers: Record<string, string> = {},
  url = ANALYSIS_URL,
  method = "POST",
): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ANALYSIS_TOKEN}`,
      ...headers,
    },
    body,
  });
}

test("unknown analysis paths return 404", async () => {
  const cases = [
    new Request("https://gateway.example/internal/analysis", { method: "POST" }),
    new Request("https://gateway.example/internal/nope", { method: "GET" }),
  ];

  for (const request of cases) {
    const { database, prepareCount } = createDatabase();
    const response = await readResponse(
      await handleCrawlGatewayRequest(request, gatewayEnv(database)),
    );

    assert.equal(response.status, 404);
    assert.equal(response.text, '{"error":"not_found"}');
    assert.equal(prepareCount(), 0);
  }
});

test("a query string on the analysis path returns 404", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 }), {}, `${ANALYSIS_URL}?x=1`),
      gatewayEnv(database, {
        CRAWL_GATEWAY_TOKEN: CRAWL_TOKEN,
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
      }),
    ),
  );

  assert.equal(response.status, 404);
  assert.equal(response.text, '{"error":"not_found"}');
  assert.equal(prepareCount(), 0);
});

test("a non-POST analysis request returns 405", async () => {
  const { database, prepareCount } = createDatabase();
  const env = gatewayEnv(database, {
    ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
    GEMINI_API_KEY: GEMINI_KEY,
  });
  const authorized = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(ANALYSIS_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${ANALYSIS_TOKEN}` },
      }),
      env,
    ),
  );
  const anonymous = await readResponse(
    await handleCrawlGatewayRequest(new Request(ANALYSIS_URL, { method: "GET" }), env),
  );

  assert.equal(authorized.status, 405);
  assert.equal(authorized.text, '{"error":"method_not_allowed"}');
  assert.equal(anonymous.status, 405);
  assert.equal(anonymous.text, '{"error":"method_not_allowed"}');
  assert.equal(prepareCount(), 0);
});

test("a missing presented analysis token returns 401", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(ANALYSIS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxItems: 0 }),
      }),
      gatewayEnv(database, {
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
      }),
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.text, '{"error":"unauthorized"}');
  assert.equal(prepareCount(), 0);
});

test("a wrong analysis token returns 401", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 }), {
        authorization: "Bearer not-the-analysis-token",
      }),
      gatewayEnv(database, {
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
      }),
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.text, '{"error":"unauthorized"}');
  assert.equal(prepareCount(), 0);
});

test("a lowercase bearer scheme returns 401", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 }), {
        authorization: `bearer ${ANALYSIS_TOKEN}`,
      }),
      gatewayEnv(database, {
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
      }),
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.text, '{"error":"unauthorized"}');
  assert.equal(prepareCount(), 0);
});

test("CRAWL_GATEWAY_TOKEN does not authorize the analysis route", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 }), {
        authorization: `Bearer ${CRAWL_TOKEN}`,
      }),
      gatewayEnv(database, {
        CRAWL_GATEWAY_TOKEN: CRAWL_TOKEN,
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
      }),
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.text, '{"error":"unauthorized"}');
  assert.equal(prepareCount(), 0);
});

test("a missing or empty configured analysis token fails closed", async () => {
  const cases: Array<(database: CrawlGatewayDatabase) => ReturnType<typeof gatewayEnv>> = [
    (database) => gatewayEnv(database, { GEMINI_API_KEY: GEMINI_KEY }),
    (database) =>
      gatewayEnv(database, {
        ANALYSIS_GATEWAY_TOKEN: "",
        GEMINI_API_KEY: GEMINI_KEY,
      }),
    (database) => ({
      DB: database,
      ANALYSIS_GATEWAY_TOKEN: 1 as unknown as string,
      GEMINI_API_KEY: GEMINI_KEY,
    }),
  ];

  for (const buildEnv of cases) {
    const { database, prepareCount } = createDatabase();
    const response = await readResponse(
      await handleCrawlGatewayRequest(
        analysisRequest(JSON.stringify({ maxItems: 0 })),
        buildEnv(database),
      ),
    );

    assert.equal(response.status, 401);
    assert.equal(response.text, '{"error":"unauthorized"}');
    assert.equal(prepareCount(), 0);
  }
});

test("authentication and request validation precede Gemini configuration", async () => {
  const { database, prepareCount } = createDatabase();
  const env = gatewayEnv(database, { ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN });
  const missingToken = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(ANALYSIS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxItems: 0 }),
      }),
      env,
    ),
  );
  const invalidMaxItems = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: -1 })),
      env,
    ),
  );

  assert.equal(missingToken.status, 401);
  assert.equal(missingToken.text, '{"error":"unauthorized"}');
  assert.equal(invalidMaxItems.status, 400);
  assert.equal(invalidMaxItems.text, '{"error":"invalid_request"}');
  assert.equal(prepareCount(), 0);
});

test("valid maxItems 0 returns the zero summary", async () => {
  const { database, prepareCount } = createDatabase({
    first: () => Promise.resolve(null),
  });
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 })),
      gatewayEnv(database, {
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
        GEMINI_DAILY_REQUEST_LIMIT: "10",
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.text, zeroSummaryText());
  assert.equal(prepareCount(), 1);
});

test("application/json; charset=utf-8 is accepted", async () => {
  const { database, prepareCount } = createDatabase({
    first: () => Promise.resolve(null),
  });
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 }), {
        "content-type": "application/json; charset=utf-8",
      }),
      gatewayEnv(database, {
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
        GEMINI_DAILY_REQUEST_LIMIT: "10",
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.text, zeroSummaryText());
  assert.equal(prepareCount(), 1);
});

test("maxItems below 0, above 50, fractional, string, missing, null, or extra is rejected", async () => {
  const bodies = [
    { maxItems: -1 },
    { maxItems: 51 },
    { maxItems: 1.5 },
    { maxItems: "1" },
    {},
    { maxItems: null },
    { maxItems: 1, extra: true },
  ];

  for (const body of bodies) {
    const { database, prepareCount } = createDatabase();
    const response = await readResponse(
      await handleCrawlGatewayRequest(
        analysisRequest(JSON.stringify(body)),
        gatewayEnv(database, {
          ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
          GEMINI_API_KEY: GEMINI_KEY,
        }),
      ),
    );

    assert.equal(response.status, 400);
    assert.equal(response.text, '{"error":"invalid_request"}');
    assert.equal(prepareCount(), 0);
  }
});

test("a null or array body is rejected", async () => {
  for (const body of ["null", "[]"]) {
    const { database, prepareCount } = createDatabase();
    const response = await readResponse(
      await handleCrawlGatewayRequest(
        analysisRequest(body),
        gatewayEnv(database, {
          ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
          GEMINI_API_KEY: GEMINI_KEY,
        }),
      ),
    );

    assert.equal(response.status, 400);
    assert.equal(response.text, '{"error":"invalid_request"}');
    assert.equal(prepareCount(), 0);
  }
});

test("malformed, oversized, and extra-field analysis bodies are rejected", async () => {
  const { database, prepareCount } = createDatabase();
  const env = gatewayEnv(database, {
    ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
    GEMINI_API_KEY: GEMINI_KEY,
  });
  const malformed = await readResponse(
    await handleCrawlGatewayRequest(analysisRequest("{"), env),
  );
  const plain = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 }), { "content-type": "text/plain" }),
      env,
    ),
  );
  const compactCharset = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 }), {
        "content-type": "application/json;charset=utf-8",
      }),
      env,
    ),
  );
  const extra = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 1, extra: true })),
      env,
    ),
  );

  let textCalled = false;
  const oversizedHeader = analysisRequest(JSON.stringify({ maxItems: 0 }), {
    "content-length": "3145729",
  });
  oversizedHeader.text = async () => {
    textCalled = true;
    return JSON.stringify({ maxItems: 0 });
  };
  const oversizedHeaderResponse = await readResponse(
    await handleCrawlGatewayRequest(oversizedHeader, env),
  );

  const leadingZero = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 }), { "content-length": "01" }),
      env,
    ),
  );

  const oversizedBody = analysisRequest(JSON.stringify({ maxItems: 0 }));
  oversizedBody.text = async () => "x".repeat(3_145_729);
  const oversizedBodyResponse = await readResponse(
    await handleCrawlGatewayRequest(oversizedBody, env),
  );

  for (const response of [malformed, plain, compactCharset, extra, oversizedHeaderResponse, leadingZero, oversizedBodyResponse]) {
    assert.equal(response.status, 400);
    assert.equal(response.text, '{"error":"invalid_request"}');
  }
  assert.equal(textCalled, false);
  assert.equal(prepareCount(), 0);
});

test("an invalid Gemini key returns a fixed 500 and does not echo the key", async () => {
  const keys: Array<string | undefined> = [
    undefined,
    "",
    " ",
    "\n",
    "\u0001",
    "\u007f",
    " gemini-key-do-not-reflect",
  ];

  for (const key of keys) {
    const { database, prepareCount } = createDatabase({
      all: async () => Promise.reject(new Error("selection-sentinel")),
    });
    const fields: {
      ANALYSIS_GATEWAY_TOKEN: string;
      GEMINI_API_KEY?: string;
    } = { ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN };
    if (key !== undefined) {
      fields.GEMINI_API_KEY = key;
    }
    const response = await readResponse(
      await handleCrawlGatewayRequest(
        analysisRequest(JSON.stringify({ maxItems: 1 })),
        gatewayEnv(database, fields),
      ),
    );

    assert.equal(response.status, 500);
    assert.equal(response.text, '{"error":"internal_error"}');
    assert.equal(response.text.includes("gemini-key-do-not-reflect"), false);
    assert.equal(response.text.includes("selection-sentinel"), false);
    assert.equal(prepareCount(), 0);
  }
});

const SUMMARY_TEXT = '{"selected":4,"succeeded":3,"failed":1,"retried":2,"persisted":3,"budget":{"utcDate":"2026-10-24","websitesAdmitted":0,"websiteLimit":50,"geminiRequestsUsed":0,"geminiRequestLimit":10,"stoppedReason":"no_evidence"}}';

function pipelineSummary() {
  return {
    selected: 4,
    succeeded: 3,
    failed: 1,
    retried: 2,
    persisted: 3,
    budget: {
      utcDate: "2026-10-24",
      websitesAdmitted: 0,
      websiteLimit: 50 as const,
      geminiRequestsUsed: 0,
      geminiRequestLimit: 10,
      stoppedReason: "no_evidence" as const,
    },
    html: "<p>html-sentinel</p>",
    apiKey: GEMINI_KEY,
  };
}

function createPipelineSpy(behavior?: {
  throwError?: () => Error;
  onCall?: () => void;
}) {
  const calls: Array<{
    database: unknown;
    config: { readonly provider: "gemini"; readonly apiKey: string; readonly dailyRequestLimit: number };
    maxItems: number;
    options: unknown;
  }> = [];
  const summary = pipelineSummary();
  const runPipeline: typeof runD1WebsiteAnalysisPipeline = (
    database,
    config,
    maxItems,
    options,
  ) => {
    calls.push({ database, config, maxItems, options });
    behavior?.onCall?.();
    if (behavior?.throwError !== undefined) {
      throw behavior.throwError();
    }
    return Promise.resolve(summary);
  };
  return { calls, runPipeline };
}

function validAnalysisEnv(database: CrawlGatewayDatabase) {
  return gatewayEnv(database, {
    CRAWL_GATEWAY_TOKEN: CRAWL_TOKEN,
    ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
    GEMINI_API_KEY: GEMINI_KEY,
    GEMINI_DAILY_REQUEST_LIMIT: "10",
  });
}

test("the pipeline is called once with the forwarded DB, Gemini config, and maxItems", async () => {
  for (const maxItems of [0, 1, 50]) {
    const { database, prepareCount } = createDatabase();
    const { calls, runPipeline } = createPipelineSpy();
    await readResponse(
      await handleCrawlGatewayRequest(
        analysisRequest(JSON.stringify({ maxItems })),
        validAnalysisEnv(database),
        { runPipeline },
      ),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.database, database);
    assert.deepEqual(calls[0]?.config, { provider: "gemini", apiKey: GEMINI_KEY, dailyRequestLimit: 10 });
    assert.equal(Object.isFrozen(calls[0]?.config), true);
    assert.equal(calls[0]?.maxItems, maxItems);
    assert.equal(calls[0]?.options, undefined);
    assert.equal(prepareCount(), 0);
  }
});

test("the pipeline result becomes the exact summary and budget", async () => {
  const { database, prepareCount } = createDatabase();
  const { runPipeline } = createPipelineSpy();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 1 })),
      validAnalysisEnv(database),
      { runPipeline },
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.text, SUMMARY_TEXT);
  assert.equal(response.text.includes("html-sentinel"), false);
  assert.deepEqual(Object.keys(response.body as object), [
    "selected",
    "succeeded",
    "failed",
    "retried",
    "persisted",
    "budget",
  ]);
  assert.equal(prepareCount(), 0);
});

test("a thrown pipeline error becomes a fixed 500 without the thrown text", async () => {
  const errors = [
    () => new Error("boom gemini-key-do-not-reflect"),
    () => new D1WebsiteAnalysisPipelineError("INVALID_REQUEST"),
    () => new D1WebsiteAnalysisPipelineError("SELECTION_FAILED"),
  ];
  const logged: string[] = [];
  const original = console.error;
  console.error = () => {
    logged.push("error");
  };

  try {
    for (const throwError of errors) {
      const { database, prepareCount } = createDatabase();
      const { runPipeline } = createPipelineSpy({ throwError });
      const response = await readResponse(
        await handleCrawlGatewayRequest(
          analysisRequest(JSON.stringify({ maxItems: 1 })),
          validAnalysisEnv(database),
          { runPipeline },
        ),
      );

      assert.equal(response.status, 500);
      assert.equal(response.text, '{"error":"internal_error"}');
      assert.equal(response.text.includes("boom"), false);
      assert.equal(response.text.includes("D1 website analysis pipeline request is invalid."), false);
      assert.equal(response.text.includes("D1 website analysis selection failed."), false);
      assert.equal(prepareCount(), 0);
    }
  } finally {
    console.error = original;
  }

  assert.deepEqual(logged, []);
});

test("an invalid Gemini key does not call the pipeline when maxItems is 0", async () => {
  const { database, prepareCount } = createDatabase();
  const { calls, runPipeline } = createPipelineSpy({
    throwError: () => new Error("pipeline-must-not-run"),
  });
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 })),
      gatewayEnv(database, {
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: " gemini-key-do-not-reflect",
      }),
      { runPipeline },
    ),
  );

  assert.equal(response.status, 500);
  assert.equal(response.text, '{"error":"internal_error"}');
  assert.equal(calls.length, 0);
  assert.equal(prepareCount(), 0);
});

test("an invalid analysis request does not call the pipeline", async () => {
  const { database, prepareCount } = createDatabase();
  const { calls, runPipeline } = createPipelineSpy();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 51 })),
      validAnalysisEnv(database),
      { runPipeline },
    ),
  );

  assert.equal(response.status, 400);
  assert.equal(response.text, '{"error":"invalid_request"}');
  assert.equal(calls.length, 0);
  assert.equal(prepareCount(), 0);
});

test("ANALYSIS_GATEWAY_TOKEN does not authorize a crawl route", async () => {
  const { database, prepareCount } = createDatabase();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(SELECT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ANALYSIS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ maxAttempts: 1 }),
      }),
      gatewayEnv(database, {
        CRAWL_GATEWAY_TOKEN: CRAWL_TOKEN,
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
      }),
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.text, '{"error":"unauthorized"}');
  assert.equal(prepareCount(), 0);
});

test("crawl select still succeeds with its own token while analysis secrets are present", async () => {
  const { database, prepareCount } = createDatabase({
    all: async () => ({ results: [] }),
  });
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      new Request(SELECT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CRAWL_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ maxAttempts: 1 }),
      }),
      gatewayEnv(database, {
        CRAWL_GATEWAY_TOKEN: CRAWL_TOKEN,
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { candidates: [] });
  assert.equal(prepareCount() > 0, true);
});

test("worker fetch runs maxItems 0 without a pipeline override", async () => {
  const { database, prepareCount } = createDatabase({
    first: () => Promise.resolve(null),
  });
  const response = await readResponse(
    await worker.fetch(
      analysisRequest(JSON.stringify({ maxItems: 0 })),
      gatewayEnv(database, {
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
        GEMINI_DAILY_REQUEST_LIMIT: "10",
      }),
    ),
  );

  assert.equal(worker.fetch.length, 2);
  assert.equal(response.status, 200);
  assert.equal(response.text, zeroSummaryText());
  assert.equal(prepareCount(), 1);
});

test("the analysis success body copies counters and budget without analysis content", async () => {
  const { database } = createDatabase();
  const budget = {
    utcDate: "2026-10-24",
    websitesAdmitted: 1,
    websiteLimit: 50 as const,
    geminiRequestsUsed: 1,
    geminiRequestLimit: 10,
    stoppedReason: "no_evidence" as const,
  };
  const runPipeline: typeof runD1WebsiteAnalysisPipeline = () => Promise.resolve({
    selected: 1,
    succeeded: 1,
    failed: 0,
    retried: 0,
    persisted: 1,
    budget,
  });
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 1 })),
      validAnalysisEnv(database),
      { runPipeline },
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.text,
    '{"selected":1,"succeeded":1,"failed":0,"retried":0,"persisted":1,"budget":{"utcDate":"2026-10-24","websitesAdmitted":1,"websiteLimit":50,"geminiRequestsUsed":1,"geminiRequestLimit":10,"stoppedReason":"no_evidence"}}',
  );
  assert.equal(response.text.includes(GEMINI_KEY), false);
  assert.equal(response.text.includes(ANALYSIS_TOKEN), false);
  assert.equal(response.text.includes("summary"), false);
  assert.equal(response.text.includes("findings"), false);
});

test("a zero maxItems success copies the unread budget from the pipeline", async () => {
  const { database } = createDatabase();
  const budget = {
    utcDate: "2026-10-24",
    websitesAdmitted: 4,
    websiteLimit: 50 as const,
    geminiRequestsUsed: 2,
    geminiRequestLimit: 10,
    stoppedReason: "max_items" as const,
  };
  const runPipeline: typeof runD1WebsiteAnalysisPipeline = () => Promise.resolve({
    selected: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    persisted: 0,
    budget,
  });
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 0 })),
      validAnalysisEnv(database),
      { runPipeline },
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual((response.body as { budget: unknown }).budget, budget);
});

test("a thrown pipeline error stays a fixed 500", async () => {
  const { database } = createDatabase();
  const runPipeline: typeof runD1WebsiteAnalysisPipeline = () => {
    const error = new D1WebsiteAnalysisPipelineError("BUDGET_FAILED");
    error.message = `D1 website analysis budget ledger failed. ${GEMINI_KEY}`;
    throw error;
  };
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 1 })),
      validAnalysisEnv(database),
      { runPipeline },
    ),
  );
  assert.equal(response.status, 500);
  assert.equal(response.text, '{"error":"internal_error"}');
  assert.equal(response.text.includes("BUDGET_FAILED"), false);
  assert.equal(response.text.includes(GEMINI_KEY), false);
});

test("wrangler.toml does not gain analysis secrets", () => {
  const toml = readFileSync(join(process.cwd(), "wrangler.toml"), "utf8");
  assert.equal(toml.includes('name = "delta-qoralis-crawl-gateway"'), true);
  assert.equal(toml.includes('binding = "DB"'), true);
  assert.equal(toml.includes("ANALYSIS_GATEWAY_TOKEN"), false);
  assert.equal(toml.includes("GEMINI_API_KEY"), false);
  assert.equal(toml.includes("CRAWL_GATEWAY_TOKEN"), false);
});

test("a missing or invalid Gemini daily request limit returns a fixed 500 and does not call the pipeline", async () => {
  const limits: Array<string | undefined> = [undefined, "", "0", "01", "10001", " 3"];
  for (const limit of limits) {
    const { database, prepareCount } = createDatabase();
    const { calls, runPipeline } = createPipelineSpy();
    const fields: {
      ANALYSIS_GATEWAY_TOKEN: string;
      GEMINI_API_KEY: string;
      GEMINI_DAILY_REQUEST_LIMIT?: string;
    } = {
      ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
      GEMINI_API_KEY: GEMINI_KEY,
    };
    if (limit !== undefined) {
      fields.GEMINI_DAILY_REQUEST_LIMIT = limit;
    }
    const response = await readResponse(
      await handleCrawlGatewayRequest(
        analysisRequest(JSON.stringify({ maxItems: 0 })),
        gatewayEnv(database, fields),
        { runPipeline },
      ),
    );
    assert.equal(response.status, 500);
    assert.equal(response.text, '{"error":"internal_error"}');
    assert.equal(response.text.includes(GEMINI_KEY), false);
    if (limit !== undefined && limit.length > 0) {
      assert.equal(response.text.includes(limit), false);
    }
    assert.equal(calls.length, 0);
    assert.equal(prepareCount(), 0);
  }
});

test("maxItems is validated before the Gemini daily request limit", async () => {
  const { database, prepareCount } = createDatabase();
  const { calls, runPipeline } = createPipelineSpy();
  const response = await readResponse(
    await handleCrawlGatewayRequest(
      analysisRequest(JSON.stringify({ maxItems: 51 })),
      gatewayEnv(database, {
        ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
        GEMINI_API_KEY: GEMINI_KEY,
      }),
      { runPipeline },
    ),
  );
  assert.equal(response.status, 400);
  assert.equal(response.text, '{"error":"invalid_request"}');
  assert.equal(calls.length, 0);
  assert.equal(prepareCount(), 0);
});

test("a valid request limit is frozen onto the Gemini config", async () => {
  const { database } = createDatabase();
  const { calls, runPipeline } = createPipelineSpy();
  await handleCrawlGatewayRequest(
    analysisRequest(JSON.stringify({ maxItems: 0 })),
    gatewayEnv(database, {
      ANALYSIS_GATEWAY_TOKEN: ANALYSIS_TOKEN,
      GEMINI_API_KEY: GEMINI_KEY,
      GEMINI_DAILY_REQUEST_LIMIT: "10",
    }),
    { runPipeline },
  );
  assert.deepEqual(calls[0]?.config, { provider: "gemini", apiKey: GEMINI_KEY, dailyRequestLimit: 10 });
  assert.equal(Object.isFrozen(calls[0]?.config), true);
  assert.equal(calls[0]?.options, undefined);
});

test("the worker does not call loadConfig", () => {
  const source = readFileSync(join(process.cwd(), "src/crawl-gateway/worker.ts"), "utf8");
  assert.equal(source.includes("loadConfig"), false);
  assert.equal(source.includes("ANALYSIS_GATEWAY_TOKEN"), true);
  assert.equal(source.includes("runD1WebsiteAnalysisPipeline"), true);
});
