import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CrawlCloudConfigurationError,
  loadCrawlCloudConfig,
  type CrawlCloudConfig,
} from "../../src/crawl-cloud/config";
import {
  CrawlGatewayError,
  createCrawlGatewayClient,
} from "../../src/crawl-cloud/gateway-client";
import type { SinglePageCrawlEvidence } from "../../src/crawler/single-page-evidence";

const TOKEN = "gateway-token-do-not-reflect";
const HTML_SENTINEL = "<p>html-sentinel</p>";
const LEAD_ID = "00000000-0000-4000-8000-000000000001";

const config: CrawlCloudConfig = {
  gatewayUrl: "https://gateway.example",
  token: TOKEN,
  maxAttempts: 10,
};

const manualLead = {
  id: LEAD_ID,
  businessName: "Distinctive Business Name",
  sourceKind: "manual" as const,
  sourceReference: "ref-distinctive",
  status: "recorded" as const,
  websiteObservation: { presence: "present" as const, url: "https://example.com/" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  version: 3,
};

const discoveredLead = {
  ...manualLead,
  sourceKind: "discovery" as const,
  sourceProvider: "fixture_directory",
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

async function expectGatewayError(
  operation: Promise<unknown>,
  absent: readonly string[],
): Promise<void> {
  const error = await operation.then(
    () => {
      assert.fail("expected rejection");
    },
    (caught: unknown) => caught,
  );
  if (!(error instanceof CrawlGatewayError)) {
    assert.fail("expected CrawlGatewayError");
  }
  assert.equal(error.message, "Crawl gateway request failed.");
  const rendered = `${error.message}\n${String(error)}`;
  for (const value of absent) {
    assert.equal(rendered.includes(value), false);
  }
}

test("loadCrawlCloudConfig reads the gateway origin token and attempt count", () => {
  assert.deepEqual(
    loadCrawlCloudConfig({
      CRAWL_GATEWAY_URL: "https://gateway.example/",
      CRAWL_GATEWAY_TOKEN: TOKEN,
    }),
    {
      gatewayUrl: "https://gateway.example/",
      token: TOKEN,
      maxAttempts: 10,
    },
  );
  assert.equal(
    loadCrawlCloudConfig({
      CRAWL_GATEWAY_URL: "https://gateway.example/",
      CRAWL_GATEWAY_TOKEN: TOKEN,
      CRAWL_MAX_ATTEMPTS: "60",
    }).maxAttempts,
    60,
  );
  assert.equal(
    loadCrawlCloudConfig({
      CRAWL_GATEWAY_URL: "https://gateway.example/",
      CRAWL_GATEWAY_TOKEN: TOKEN,
      CRAWL_MAX_ATTEMPTS: "10",
    }).maxAttempts,
    10,
  );
});

test("loadCrawlCloudConfig rejects missing and unsafe values", () => {
  const environments: ReadonlyArray<Readonly<Record<string, string | undefined>>> = [
    { CRAWL_GATEWAY_TOKEN: TOKEN },
    { CRAWL_GATEWAY_URL: "https://gateway.example" },
    { CRAWL_GATEWAY_URL: "https://gateway.example", CRAWL_GATEWAY_TOKEN: "" },
    { CRAWL_GATEWAY_URL: "https://gateway.example", CRAWL_GATEWAY_TOKEN: "bad token" },
    { CRAWL_GATEWAY_URL: "http://gateway.example", CRAWL_GATEWAY_TOKEN: TOKEN },
    { CRAWL_GATEWAY_URL: "https://user:pass@gateway.example", CRAWL_GATEWAY_TOKEN: TOKEN },
    { CRAWL_GATEWAY_URL: "https://gateway.example/crawl", CRAWL_GATEWAY_TOKEN: TOKEN },
    { CRAWL_GATEWAY_URL: "https://gateway.example?x=1", CRAWL_GATEWAY_TOKEN: TOKEN },
    {
      CRAWL_GATEWAY_URL: "https://gateway.example",
      CRAWL_GATEWAY_TOKEN: TOKEN,
      CRAWL_MAX_ATTEMPTS: "0",
    },
    {
      CRAWL_GATEWAY_URL: "https://gateway.example",
      CRAWL_GATEWAY_TOKEN: TOKEN,
      CRAWL_MAX_ATTEMPTS: "61",
    },
    {
      CRAWL_GATEWAY_URL: "https://gateway.example",
      CRAWL_GATEWAY_TOKEN: TOKEN,
      CRAWL_MAX_ATTEMPTS: "1.5",
    },
    {
      CRAWL_GATEWAY_URL: "https://gateway.example",
      CRAWL_GATEWAY_TOKEN: TOKEN,
      CRAWL_MAX_ATTEMPTS: "01",
    },
    {
      CRAWL_GATEWAY_URL: "https://gateway.example",
      CRAWL_GATEWAY_TOKEN: TOKEN,
      CRAWL_MAX_ATTEMPTS: "10 ",
    },
  ];

  for (const environment of environments) {
    assert.throws(
      () => loadCrawlCloudConfig(environment),
      (error: unknown) => {
        if (!(error instanceof CrawlCloudConfigurationError)) {
          return false;
        }
        assert.equal(error.message, "Crawl gateway configuration is invalid.");
        assert.equal(error.message.includes("gateway.example"), false);
        assert.equal(error.message.includes("bad token"), false);
        assert.equal(error.message.includes("user"), false);
        return true;
      },
    );
  }
});

test("select posts bearer and maxAttempts and returns the same BusinessLead fields", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    const headers = new Headers(init?.headers);
    assert.equal(String(input), "https://gateway.example/internal/crawl/select");
    assert.equal(init?.method, "POST");
    assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(init?.body, '{"maxAttempts":10}');
    return jsonResponse(200, { candidates: [manualLead] });
  };
  const client = createCrawlGatewayClient(config, fetchImpl);
  const selected = await client.select(10, signal());

  assert.deepEqual(selected, [manualLead]);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected[0]), true);
  assert.equal(Object.isFrozen(selected[0]?.websiteObservation), true);
  assert.equal(calls, 1);
});

test("decodeBusinessLeadSnapshots accepts a valid manual BusinessLead", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse(200, { candidates: [manualLead] });
  const selected = await createCrawlGatewayClient(config, fetchImpl).select(10, signal());

  assert.deepEqual(selected, [manualLead]);
  assert.equal("sourceProvider" in selected[0], false);
});

test("decodeBusinessLeadSnapshots accepts a valid discovered BusinessLead", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse(200, { candidates: [discoveredLead] });
  const selected = await createCrawlGatewayClient(config, fetchImpl).select(10, signal());

  assert.deepEqual(selected, [discoveredLead]);
  assert.equal(selected[0]?.sourceKind === "discovery" && selected[0].sourceProvider, "fixture_directory");
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected[0]), true);
  assert.equal(Object.isFrozen(selected[0]?.websiteObservation), true);
});

test("select decoder rejects a snapshot that omits businessName", async () => {
  const incomplete = { ...manualLead };
  delete (incomplete as { businessName?: string }).businessName;
  const fetchImpl: typeof fetch = async () => jsonResponse(200, { candidates: [incomplete] });

  await expectGatewayError(createCrawlGatewayClient(config, fetchImpl).select(10, signal()), [
    "Distinctive",
    "example.com",
    TOKEN,
  ]);
});

test("decodeBusinessLeadSnapshots rejects an unexpected field", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(200, { candidates: [{ ...manualLead, websiteUrl: "https://example.com/" }] });

  await expectGatewayError(createCrawlGatewayClient(config, fetchImpl).select(10, signal()), [
    "websiteUrl",
    "https://example.com/",
  ]);
});

test("decodeBusinessLeadSnapshots rejects a malformed website observation", async () => {
  const observations = [
    { presence: "present" },
    { presence: "unknown", url: "https://example.com/" },
    { presence: "missing", extra: true },
  ];

  for (const websiteObservation of observations) {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(200, { candidates: [{ ...manualLead, websiteObservation }] });
    await expectGatewayError(createCrawlGatewayClient(config, fetchImpl).select(10, signal()), [
      "example.com",
    ]);
  }
});

test("decodeBusinessLeadSnapshots rejects malformed id version and timestamps", async () => {
  const replacements = [
    { id: "not-a-uuid", absent: "not-a-uuid" },
    { version: 1.5, absent: "1.5" },
    { version: 0, absent: "0" },
    { createdAt: "2026-01-01", absent: "2026-01-01" },
    { updatedAt: "2026-01-02T00:00:00.000", absent: "2026-01-02T00:00:00.000" },
  ];

  for (const replacement of replacements) {
    const { absent, ...fields } = replacement;
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(200, { candidates: [{ ...manualLead, ...fields }] });
    await expectGatewayError(createCrawlGatewayClient(config, fetchImpl).select(10, signal()), [
      absent,
    ]);
  }
});

test("decodeBusinessLeadSnapshots rejects a bad source-kind relationship", async () => {
  const discoveryWithoutProvider: Record<string, unknown> = { ...discoveredLead };
  delete discoveryWithoutProvider.sourceProvider;
  const candidates = [
    { ...manualLead, sourceProvider: "fixture_directory" },
    discoveryWithoutProvider,
    { ...discoveredLead, sourceProvider: "Bad-Provider" },
  ];

  for (const candidate of candidates) {
    const fetchImpl: typeof fetch = async () => jsonResponse(200, { candidates: [candidate] });
    await expectGatewayError(createCrawlGatewayClient(config, fetchImpl).select(10, signal()), []);
  }
});

test("decodeBusinessLeadSnapshots rejects the whole response when one element is bad", async () => {
  const incomplete = { ...manualLead };
  delete (incomplete as { businessName?: string }).businessName;
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(200, { candidates: [manualLead, incomplete] });

  await expectGatewayError(createCrawlGatewayClient(config, fetchImpl).select(10, signal()), []);
});

test("gateway client source names the decoder and does not cast the response", () => {
  const source = readFileSync(
    join(process.cwd(), "src/crawl-cloud/gateway-client.ts"),
    "utf8",
  );
  assert.equal(source.includes("function decodeBusinessLeadSnapshots"), true);
  assert.equal(source.includes("as BusinessLead"), false);
});

test("malformed select JSON is rejected", async () => {
  const bodies = ["not-json", JSON.stringify({ candidates: [], extra: true })];
  for (const body of bodies) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(200, body);
    };
    await expectGatewayError(createCrawlGatewayClient(config, fetchImpl).select(10, signal()), []);
    assert.equal(calls, 1);
  }
});

test("non-2xx select fails once with a fixed error", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(500, {
      error: "internal_error",
      detail: `https://secret.example ${TOKEN}`,
    });
  };

  await expectGatewayError(createCrawlGatewayClient(config, fetchImpl).select(10, signal()), [
    "secret.example",
    TOKEN,
    "internal_error",
  ]);
  assert.equal(calls, 1);
});

test("evidence post sends fetched keys and persist success has no id", async () => {
  const evidence: SinglePageCrawlEvidence = {
    outcome: "fetched",
    leadId: LEAD_ID,
    leadVersion: 1,
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    statusCode: 200,
    contentType: "text/html",
    bodyText: HTML_SENTINEL,
    byteLength: Buffer.byteLength(HTML_SENTINEL, "utf8"),
    redirectCount: 0,
    attemptedAt: "2026-10-22T00:00:00.000Z",
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input).endsWith("/internal/crawl/evidence"), true);
    const posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.deepEqual(posted, evidence);
    assert.deepEqual(Object.keys(posted), [
      "outcome",
      "leadId",
      "leadVersion",
      "requestedUrl",
      "finalUrl",
      "statusCode",
      "contentType",
      "bodyText",
      "byteLength",
      "redirectCount",
      "attemptedAt",
    ]);
    return jsonResponse(200, { persisted: true });
  };
  const result = await createCrawlGatewayClient(config, fetchImpl).persist(evidence, signal());

  assert.deepEqual(result, evidence);
  assert.equal("id" in result, false);
});

test("evidence post sends failed keys", async () => {
  const evidence: SinglePageCrawlEvidence = {
    outcome: "failed",
    leadId: LEAD_ID,
    leadVersion: 1,
    requestedUrl: "https://example.com/",
    failure: "TIMEOUT",
    attemptedAt: "2026-10-22T00:00:00.000Z",
  };
  const fetchImpl: typeof fetch = async (_input, init) => {
    const posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.deepEqual(posted, evidence);
    assert.deepEqual(Object.keys(posted), [
      "outcome",
      "leadId",
      "leadVersion",
      "requestedUrl",
      "failure",
      "attemptedAt",
    ]);
    return jsonResponse(200, { persisted: true });
  };

  await createCrawlGatewayClient(config, fetchImpl).persist(evidence, signal());
});

test("non-2xx persist fails with a fixed error and does not include the body", async () => {
  let calls = 0;
  const evidence: SinglePageCrawlEvidence = {
    outcome: "failed",
    leadId: LEAD_ID,
    leadVersion: 1,
    requestedUrl: "https://example.com/",
    failure: "TIMEOUT",
    attemptedAt: "2026-10-22T00:00:00.000Z",
  };
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(500, `${HTML_SENTINEL} ${TOKEN}`);
  };

  await expectGatewayError(
    createCrawlGatewayClient(config, fetchImpl).persist(evidence, signal()),
    ["html-sentinel", TOKEN],
  );
  assert.equal(calls, 1);
});

test("persist rejects a response that echoes html or an id", async () => {
  const evidence: SinglePageCrawlEvidence = {
    outcome: "failed",
    leadId: LEAD_ID,
    leadVersion: 1,
    requestedUrl: "https://example.com/",
    failure: "TIMEOUT",
    attemptedAt: "2026-10-22T00:00:00.000Z",
  };
  const bodies = [
    { persisted: true, id: 4 },
    { persisted: true, bodyText: HTML_SENTINEL },
  ];
  for (const body of bodies) {
    const fetchImpl: typeof fetch = async () => jsonResponse(200, body);
    await expectGatewayError(
      createCrawlGatewayClient(config, fetchImpl).persist(evidence, signal()),
      [],
    );
  }
});
