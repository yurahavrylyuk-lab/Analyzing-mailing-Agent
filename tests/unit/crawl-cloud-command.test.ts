import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "../../src/cli/crawl-cloud";
import { runCrawlCloudCommand } from "../../src/crawl-cloud/command";
import type { BusinessLead } from "../../src/leads/domain";
import type { SinglePageCrawlEvidence } from "../../src/crawler/single-page-evidence";

const TOKEN = "gateway-token-do-not-reflect";
const LEAD_ID = "00000000-0000-4000-8000-000000000001";

const env = {
  CRAWL_GATEWAY_URL: "https://gateway.example",
  CRAWL_GATEWAY_TOKEN: TOKEN,
};

const lead = {
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

const failedEvidence: SinglePageCrawlEvidence = {
  outcome: "failed",
  leadId: LEAD_ID,
  leadVersion: 3,
  requestedUrl: "https://example.com/",
  failure: "TIMEOUT",
  attemptedAt: "2026-10-22T00:00:00.000Z",
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

test("missing gateway url exits 1 with the configuration sentence", async () => {
  let calls = 0;
  const result = await runCrawlCloudCommand(
    {
      env: { CRAWL_GATEWAY_TOKEN: TOKEN },
      signal: signal(),
    },
    {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200, { candidates: [] });
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Crawl gateway configuration is invalid.\n");
  assert.equal(calls, 0);
});

test("missing token exits 1", async () => {
  let calls = 0;
  const result = await runCrawlCloudCommand(
    {
      env: { CRAWL_GATEWAY_URL: "https://gateway.example" },
      signal: signal(),
    },
    {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200, { candidates: [] });
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "Crawl gateway configuration is invalid.\n");
  assert.equal(calls, 0);
});

test("invalid url exits 1 and does not print the url", async () => {
  const result = await runCrawlCloudCommand({
    env: {
      CRAWL_GATEWAY_URL: "http://user:secret-url-sentinel@gateway.example/crawl",
      CRAWL_GATEWAY_TOKEN: TOKEN,
    },
    signal: signal(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "Crawl gateway configuration is invalid.\n");
  const output = result.stdout + result.stderr;
  assert.equal(output.includes("secret-url-sentinel"), false);
  assert.equal(output.includes("gateway.example"), false);
});

test("token with whitespace exits 1 and does not print the token", async () => {
  const result = await runCrawlCloudCommand({
    env: {
      CRAWL_GATEWAY_URL: "https://gateway.example",
      CRAWL_GATEWAY_TOKEN: "bad token sentinel",
    },
    signal: signal(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "Crawl gateway configuration is invalid.\n");
  assert.equal((result.stdout + result.stderr).includes("bad token sentinel"), false);
});

test("default max attempts is 10", async () => {
  let posted = "";
  const result = await runCrawlCloudCommand(
    { env, signal: signal() },
    {
      fetchImpl: async (_input, init) => {
        posted = String(init?.body);
        return jsonResponse(200, { candidates: [] });
      },
    },
  );

  assert.equal(posted, '{"maxAttempts":10}');
  assert.equal(result.exitCode, 0);
});

test("max attempts 0 and 61 are configuration failures", async () => {
  for (const attempts of ["0", "61"]) {
    let calls = 0;
    const result = await runCrawlCloudCommand(
      {
        env: { ...env, CRAWL_MAX_ATTEMPTS: attempts },
        signal: signal(),
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(200, { candidates: [] });
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "Crawl gateway configuration is invalid.\n");
    assert.equal(calls, 0);
  }
});

test("max attempts 60 is accepted", async () => {
  let posted = "";
  const result = await runCrawlCloudCommand(
    {
      env: { ...env, CRAWL_MAX_ATTEMPTS: "60" },
      signal: signal(),
    },
    {
      fetchImpl: async (_input, init) => {
        posted = String(init?.body);
        return jsonResponse(200, { candidates: [] });
      },
    },
  );

  assert.equal(posted, '{"maxAttempts":60}');
  assert.equal(result.exitCode, 0);
});

test("command runs select then collect then persist once", async () => {
  const order: string[] = [];
  const commandSignal = signal();
  let persisted: unknown;
  const result = await runCrawlCloudCommand(
    { env, signal: commandSignal },
    {
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/internal/crawl/select")) {
          order.push("select");
          return jsonResponse(200, { candidates: [lead] });
        }
        order.push("persist");
        persisted = JSON.parse(String(init?.body));
        return jsonResponse(200, { persisted: true });
      },
      collect: async (received: BusinessLead, receivedSignal: AbortSignal) => {
        order.push("collect");
        assert.equal(receivedSignal, commandSignal);
        assert.deepEqual(received, lead);
        return failedEvidence;
      },
    },
  );

  assert.deepEqual(order, ["select", "collect", "persist"]);
  assert.deepEqual(persisted, failedEvidence);
  assert.equal(result.exitCode, 0);
});

test("main aborts on SIGINT", async () => {
  let calls = 0;
  let stdout = "";
  let stderr = "";
  const exitCode = await main({
    env,
    stdout: {
      write(text: string) {
        stdout += text;
      },
    },
    stderr: {
      write(text: string) {
        stderr += text;
      },
    },
    registerSigint: (handler) => {
      handler();
      return () => undefined;
    },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(500, TOKEN);
    },
  });

  assert.equal(calls, 0);
  assert.equal(exitCode, 130);
  assert.equal(stderr, "Crawl run was cancelled.\n");
  assert.equal(stdout.includes("status: cancelled"), true);
  assert.equal(stdout.includes("selected: 0"), true);
  assert.equal((stdout + stderr).includes(TOKEN), false);
});

test("summary is counts only", async () => {
  const result = await runCrawlCloudCommand(
    { env, signal: signal() },
    {
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/internal/crawl/select")) {
          return jsonResponse(200, { candidates: [lead] });
        }
        assert.deepEqual(JSON.parse(String(init?.body)), failedEvidence);
        return jsonResponse(200, { persisted: true });
      },
      collect: async () => failedEvidence,
    },
  );

  assert.equal(
    result.stdout,
    [
      "status: completed",
      "reason: candidates_exhausted",
      "selected: 1",
      "attempted: 1",
      "fetched: 0",
      "failed: 1",
      "persisted: 1",
      "",
    ].join("\n"),
  );
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  const output = result.stdout + result.stderr;
  for (const secret of ["Distinctive", "example.com", LEAD_ID, "ref-distinctive", "2026-01-01", TOKEN]) {
    assert.equal(output.includes(secret), false);
  }
});

test("budget exhausted summary uses the loop reason", async () => {
  const result = await runCrawlCloudCommand(
    {
      env: { ...env, CRAWL_MAX_ATTEMPTS: "1" },
      signal: signal(),
    },
    {
      fetchImpl: async (input) => {
        if (String(input).endsWith("/internal/crawl/select")) {
          return jsonResponse(200, { candidates: [lead] });
        }
        return jsonResponse(200, { persisted: true });
      },
      collect: async () => failedEvidence,
    },
  );

  assert.equal(result.stdout.includes("reason: budget_exhausted"), true);
});

test("cancellation returns 130 and the cancellation sentence", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runCrawlCloudCommand(
    { env, signal: controller.signal },
    {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200, { candidates: [] });
      },
    },
  );

  assert.equal(result.exitCode, 130);
  assert.equal(result.stderr, "Crawl run was cancelled.\n");
  assert.equal(result.stdout.includes("status: cancelled"), true);
  assert.equal(result.stdout.includes("selected: 0"), true);
  assert.equal(calls, 0);
});

test("cancellation after a returned attempt keeps the counts", async () => {
  const cancelled: SinglePageCrawlEvidence = {
    outcome: "failed",
    leadId: LEAD_ID,
    leadVersion: 3,
    requestedUrl: "https://example.com/",
    failure: "CANCELLED",
    attemptedAt: "2026-10-22T00:00:00.000Z",
  };
  const result = await runCrawlCloudCommand(
    { env, signal: signal() },
    {
      fetchImpl: async (input) => {
        if (String(input).endsWith("/internal/crawl/select")) {
          return jsonResponse(200, { candidates: [lead] });
        }
        return jsonResponse(200, { persisted: true });
      },
      collect: async () => cancelled,
    },
  );

  assert.equal(result.exitCode, 130);
  assert.equal(result.stdout.includes("attempted: 1"), true);
  assert.equal(result.stdout.includes("failed: 1"), true);
  assert.equal(result.stdout.includes("persisted: 1"), true);
  assert.equal(result.stdout.includes("status: cancelled"), true);
  assert.equal(result.stderr, "Crawl run was cancelled.\n");
});

test("cloud command failure output hides the gateway body and token", async () => {
  let calls = 0;
  const result = await runCrawlCloudCommand(
    { env, signal: signal() },
    {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(500, `https://secret.example ${TOKEN} <p>html-sentinel</p>`);
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "Crawl run failed.\n");
  assert.equal(result.stdout, "");
  const output = result.stdout + result.stderr;
  assert.equal(output.includes("secret.example"), false);
  assert.equal(output.includes(TOKEN), false);
  assert.equal(output.includes("html-sentinel"), false);
  assert.equal(output.includes("Error"), false);
  assert.equal(calls, 1);
});

test("command does not open local storage", () => {
  const source = readFileSync(join(process.cwd(), "src/crawl-cloud/command.ts"), "utf8");
  assert.equal(source.includes("runBoundedSinglePageCrawlWithDependencies"), true);
  assert.equal(source.includes("collectSinglePageCrawlEvidence"), true);
  assert.equal(source.includes("runBoundedSinglePageCrawl("), false);
  assert.equal(source.includes("loadConfig"), false);
  assert.equal(source.includes("createDatabase"), false);
  assert.equal(source.includes("better-sqlite3"), false);
  assert.equal(source.includes("selectD1CrawlCandidates"), false);
});
