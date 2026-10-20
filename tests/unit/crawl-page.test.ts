import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CRAWL_PAGE_ERROR_CODES,
  CRAWL_PAGE_TIMEOUT_MILLISECONDS,
  CrawlPageError,
  MAX_CRAWL_BODY_BYTES,
  MAX_CRAWL_REDIRECTS,
  fetchCrawlPage,
  type CrawlPageErrorCode,
  type CrawlPageResult,
} from "../../src/crawler";
import { fetchCrawlPageWithDependencies } from "../../src/crawler/fetch-page";
import {
  NetworkTargetError,
  type DnsAddressRecord,
  type DnsResolver,
  type NetworkTargetErrorCode,
} from "../../src/network-safety";

const MARKER = "secret-marker.example";
const publicA: DnsAddressRecord = Object.freeze({ address: "93.184.216.34", family: 4 });
const publicB: DnsAddressRecord = Object.freeze({ address: "1.1.1.1", family: 4 });
const publicC: DnsAddressRecord = Object.freeze({ address: "8.8.8.8", family: 4 });
const encoder = new TextEncoder();

const MESSAGES: Readonly<Record<CrawlPageErrorCode, string>> = {
  CANCELLED: "Crawl request was cancelled.",
  TIMEOUT: "Crawl request timed out.",
  NETWORK_FAILURE: "Crawl request failed.",
  REDIRECT_LIMIT: "Crawl redirect limit was reached.",
  REDIRECT_DOWNGRADE: "Crawl redirect changed HTTPS to HTTP.",
  HTTP_FAILURE: "Crawl response status was not usable.",
  UNSUPPORTED_CONTENT_TYPE: "Crawl response content type is not supported.",
  UNSUPPORTED_CONTENT_ENCODING: "Crawl response content encoding is not supported.",
  RESPONSE_TOO_LARGE: "Crawl response is too large.",
  INVALID_BODY: "Crawl response body is not valid UTF-8.",
};

type ScriptedResponse = {
  statusCode: number;
  location?: readonly string[];
  contentType?: string | null;
  contentLength?: string | null;
  contentEncoding?: string | null;
  chunks?: readonly Uint8Array[];
  hangRequest?: boolean;
  hangBody?: boolean;
  failure?: Error;
  cancel?: () => Promise<void> | void;
};

type RecordedRequest = {
  url: string;
  hostname: string;
  port: number;
  address: string;
  family: number;
  signal: AbortSignal;
};

class FakeResolver implements DnsResolver {
  readonly calls: string[] = [];

  constructor(
    private readonly responses: readonly (readonly DnsAddressRecord[] | Error)[],
  ) {}

  async resolve(hostname: string): Promise<readonly DnsAddressRecord[]> {
    this.calls.push(hostname);
    const response = this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
    if (response instanceof Error) {
      throw response;
    }
    return response ?? [];
  }
}

class FakeTransport {
  readonly requests: RecordedRequest[] = [];
  bodyReads = 0;
  readonly cancelCalls: number[] = [];

  constructor(private readonly scripts: readonly ScriptedResponse[]) {}

  async request(request: {
    target: { url: string; hostname: string; port: number };
    pinnedAddress: { address: string; family: number };
    signal: AbortSignal;
  }): Promise<{
    statusCode: number;
    headers: {
      location: readonly string[];
      contentType: string | null;
      contentLength: string | null;
      contentEncoding: string | null;
    };
    body: AsyncIterable<Uint8Array>;
    cancel: () => Promise<void>;
  }> {
    const index = this.requests.length;
    const script = this.scripts[index] ?? { statusCode: 500, chunks: [] };
    this.requests.push({
      url: request.target.url,
      hostname: request.target.hostname,
      port: request.target.port,
      address: request.pinnedAddress.address,
      family: request.pinnedAddress.family,
      signal: request.signal,
    });
    if (script.hangRequest === true) {
      return new Promise(() => undefined);
    }
    if (script.failure !== undefined) {
      throw script.failure;
    }

    const chunks = script.chunks ?? [encoder.encode("<html></html>")];
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        this.bodyReads += 1;
        let cursor = 0;
        return {
          next: (): Promise<IteratorResult<Uint8Array>> => {
            if (script.hangBody === true) {
              return new Promise(() => undefined);
            }
            if (cursor >= chunks.length) {
              return Promise.resolve({ done: true, value: undefined });
            }
            const value = chunks[cursor];
            cursor += 1;
            return Promise.resolve({ done: false, value });
          },
        };
      },
    };

    return {
      statusCode: script.statusCode,
      headers: {
        location: script.location ?? [],
        contentType: script.contentType === undefined ? "text/html" : script.contentType,
        contentLength: script.contentLength === undefined ? null : script.contentLength,
        contentEncoding: script.contentEncoding === undefined ? null : script.contentEncoding,
      },
      body,
      cancel: () => {
        this.cancelCalls.push(index);
        if (script.cancel !== undefined) {
          return Promise.resolve(script.cancel());
        }
        return Promise.resolve();
      },
    };
  }
}

function dependencies(
  resolver: DnsResolver,
  transport: FakeTransport,
  timeoutMilliseconds?: number,
): {
  resolver: DnsResolver;
  transport: FakeTransport;
  timeoutMilliseconds?: number;
} {
  return timeoutMilliseconds === undefined
    ? { resolver, transport }
    : { resolver, transport, timeoutMilliseconds };
}

function crawlFailure(error: unknown, code: CrawlPageErrorCode, forbidden: readonly string[] = []): boolean {
  if (!(error instanceof CrawlPageError)) {
    assert.fail("expected CrawlPageError");
  }
  assert.equal(error.name, "CrawlPageError");
  assert.equal(error.code, code);
  assert.equal(error.message, MESSAGES[code]);
  assert.equal(error instanceof NetworkTargetError, false);
  assert.equal("cause" in error, false);
  for (const marker of forbidden) {
    assert.equal(error.message.includes(marker), false, error.message);
  }
  return true;
}

function networkFailure(
  error: unknown,
  code: NetworkTargetErrorCode,
  forbidden: readonly string[] = [],
): boolean {
  if (!(error instanceof NetworkTargetError)) {
    assert.fail("expected NetworkTargetError");
  }
  assert.equal(error instanceof CrawlPageError, false);
  assert.equal(error.code, code);
  for (const marker of forbidden) {
    assert.equal(error.message.includes(marker), false, error.message);
  }
  return true;
}

async function rejectedSoon(
  operation: Promise<unknown>,
  assertError: (error: unknown) => boolean,
): Promise<void> {
  let guard: NodeJS.Timeout | undefined;
  void operation.catch(() => undefined);
  const outcome = await Promise.race([
    operation.then(
      () => ({ type: "fulfilled" as const }),
      (error: unknown) => ({ type: "rejected" as const, error }),
    ),
    new Promise<{ type: "guard" }>((resolve) => {
      guard = setTimeout(() => resolve({ type: "guard" }), 500);
    }),
  ]);
  if (guard !== undefined) {
    clearTimeout(guard);
  }
  assert.equal(outcome.type, "rejected");
  if (outcome.type === "rejected") {
    assert.ok(assertError(outcome.error));
  }
}

async function settle(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("publishes only the page-fetch constants and error codes", () => {
  assert.equal(MAX_CRAWL_REDIRECTS, 5);
  assert.equal(CRAWL_PAGE_TIMEOUT_MILLISECONDS, 15_000);
  assert.equal(MAX_CRAWL_BODY_BYTES, 1_048_576);
  assert.deepEqual(CRAWL_PAGE_ERROR_CODES, [
    "CANCELLED",
    "TIMEOUT",
    "NETWORK_FAILURE",
    "REDIRECT_LIMIT",
    "REDIRECT_DOWNGRADE",
    "HTTP_FAILURE",
    "UNSUPPORTED_CONTENT_TYPE",
    "UNSUPPORTED_CONTENT_ENCODING",
    "RESPONSE_TOO_LARGE",
    "INVALID_BODY",
  ]);
  for (const code of CRAWL_PAGE_ERROR_CODES) {
    const error = new CrawlPageError(code);
    assert.equal(error.message, MESSAGES[code]);
    assert.equal(error.name, "CrawlPageError");
    assert.equal(error.message.includes(MARKER), false);
  }
});

test("keeps the public crawler entry free of transport injection", () => {
  const crawler = require("../../src/crawler") as Record<string, unknown>;
  assert.deepEqual(Object.keys(crawler).sort(), [
    "CRAWL_PAGE_ERROR_CODES",
    "CRAWL_PAGE_TIMEOUT_MILLISECONDS",
    "CrawlPageError",
    "MAX_CRAWL_BODY_BYTES",
    "MAX_CRAWL_REDIRECTS",
    "fetchCrawlPage",
  ]);
  assert.equal(typeof fetchCrawlPage, "function");
  assert.equal(fetchCrawlPage.length, 2);

  const root = process.cwd();
  const index = readFileSync(join(root, "src/crawler/index.ts"), "utf8");
  const fetchPage = readFileSync(join(root, "src/crawler/fetch-page.ts"), "utf8");
  const transport = readFileSync(join(root, "src/crawler/node-transport.ts"), "utf8");
  for (const source of [index, fetchPage, transport, readFileSync(join(root, "src/crawler/domain.ts"), "utf8"), readFileSync(join(root, "src/crawler/errors.ts"), "utf8")]) {
    for (const forbidden of ["src/leads", "src/discovery", "src/db", "src/compliance", "src/config", "src/audit", "undici", "globalAgent"]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  }
  for (const hidden of ["fetchCrawlPageWithDependencies", "createNodeCrawlTransport", "connectPort"]) {
    assert.equal(index.includes(hidden), false, hidden);
  }
  assert.match(fetchPage, /createNodeDnsResolver\(\)/);
  assert.match(fetchPage, /createNodeCrawlTransport\(\)/);
  assert.equal(fetchPage.includes("connectPort"), false);
  assert.equal(fetchPage.includes("node:http"), false);
  assert.match(transport, /node:http/);
  assert.match(transport, /node:https/);
  assert.match(transport, /keepAlive:\s*false/);
  assert.match(transport, /autoSelectFamily:\s*false/);
  assert.match(transport, /rejectUnauthorized:\s*true/);
  assert.match(transport, /maxHeaderSize:\s*16_?384/);
  assert.equal(transport.includes("globalAgent"), false);
  assert.equal(transport.includes("undici"), false);
});

test("rejects an invalid signal before resolver or transport work", async () => {
  const resolver = new FakeResolver([[publicA]]);
  const transport = new FakeTransport([]);
  for (const signal of [undefined, null, {}, "abort", new AbortController()]) {
    await assert.rejects(
      () => fetchCrawlPageWithDependencies(`https://${MARKER}/`, signal as AbortSignal, dependencies(resolver, transport)),
      (error: unknown) => error instanceof TypeError && error.message === "Crawl signal is invalid." && !error.message.includes(MARKER),
    );
  }
  await assert.rejects(
    () => fetchCrawlPage(`http://${MARKER}/`, {} as AbortSignal),
    (error: unknown) => error instanceof TypeError && error.message === "Crawl signal is invalid.",
  );
  assert.deepEqual(resolver.calls, []);
  assert.deepEqual(transport.requests, []);
});

test("rejects an already-aborted signal without calling the resolver or transport", async () => {
  const resolver = new FakeResolver([[publicA]]);
  const transport = new FakeTransport([{ statusCode: 200 }]);
  const caller = new AbortController();
  caller.abort(new Error(`reason ${MARKER}`));
  await assert.rejects(
    fetchCrawlPageWithDependencies("https://example.com/", caller.signal, dependencies(resolver, transport)),
    (error: unknown) => crawlFailure(error, "CANCELLED", [MARKER, "example.com", "reason"]),
  );
  await assert.rejects(
    fetchCrawlPage("http://localhost/secret-marker", AbortSignal.abort(`reason ${MARKER}`)),
    (error: unknown) => crawlFailure(error, "CANCELLED", [MARKER, "localhost", "reason"]),
  );
  assert.deepEqual(resolver.calls, []);
  assert.deepEqual(transport.requests, []);
});

test("refuses unsafe targets before any transport call", async () => {
  const cases: readonly [string, NetworkTargetErrorCode, string[]][] = [
    ["file:///etc/passwd", "UNSUPPORTED_SCHEME", ["passwd", "file"]],
    [`http://user:${MARKER}@example.com/`, "CREDENTIALS_NOT_ALLOWED", [MARKER, "user"]],
    [`http://example.com:8080/${MARKER}`, "PORT_NOT_ALLOWED", ["8080", MARKER, "example.com"]],
    [`http://${MARKER}.localhost/`, "BLOCKED_HOST", [MARKER, "localhost"]],
    ["http://127.0.0.1/", "BLOCKED_ADDRESS", ["127.0.0.1"]],
    ["http://10.1.2.3/", "BLOCKED_ADDRESS", ["10.1.2.3"]],
    ["http://192.168.1.20/", "BLOCKED_ADDRESS", ["192.168"]],
    ["http://169.254.169.254/latest", "BLOCKED_ADDRESS", ["169.254.169.254", "latest"]],
    ["http://[::1]/", "BLOCKED_ADDRESS", ["::1"]],
    ["http://[fe80::1]/", "BLOCKED_ADDRESS", ["fe80"]],
    ["http://[fec0::1]/", "BLOCKED_ADDRESS", ["fec0"]],
    ["http://[feff::1]/", "BLOCKED_ADDRESS", ["feff"]],
    ["http://[3fff::1]/", "BLOCKED_ADDRESS", ["3fff"]],
    ["http://[64:ff9b:1::1]/", "BLOCKED_ADDRESS", ["64:ff9b:1"]],
    ["http://[100:0:0:1::1]/", "BLOCKED_ADDRESS", ["100:0:0:1"]],
  ];

  for (const [input, code, forbidden] of cases) {
    const resolver = new FakeResolver([[publicA]]);
    const transport = new FakeTransport([{ statusCode: 200 }]);
    await assert.rejects(
      fetchCrawlPageWithDependencies(input, new AbortController().signal, dependencies(resolver, transport)),
      (error: unknown) => networkFailure(error, code, forbidden),
    );
    assert.deepEqual(resolver.calls, []);
    assert.deepEqual(transport.requests, []);
  }
});

test("rejects mixed public and private DNS before connecting", async () => {
  for (const records of [
    [publicA, { address: "10.0.0.8", family: 4 }],
    [publicA, { address: "fec0::1", family: 6 }],
    [publicC, { address: "169.254.169.254", family: 4 }],
  ] as const) {
    const resolver = new FakeResolver([records]);
    const transport = new FakeTransport([{ statusCode: 200 }]);
    await assert.rejects(
      fetchCrawlPageWithDependencies("https://example.com/", new AbortController().signal, dependencies(resolver, transport)),
      (error: unknown) => networkFailure(error, "BLOCKED_ADDRESS", ["10.0.0.8", "fec0", "169.254", "example.com"]),
    );
    assert.deepEqual(transport.requests, []);
  }
});

test("pins only the first approved address and does not fail over", async () => {
  const resolver = new FakeResolver([[publicA, publicB, publicC]]);
  const transport = new FakeTransport([{
    statusCode: 200,
    failure: new Error(`connect ECONNREFUSED ${publicA.address}:443 ${MARKER}`),
  }]);
  await assert.rejects(
    fetchCrawlPageWithDependencies("https://Example.COM/path?q=1#frag", new AbortController().signal, dependencies(resolver, transport)),
    (error: unknown) => crawlFailure(error, "NETWORK_FAILURE", [MARKER, publicA.address, publicB.address, "ECONNREFUSED", "example.com"]),
  );
  assert.deepEqual(resolver.calls, ["example.com"]);
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.requests[0], {
    url: "https://example.com/path?q=1",
    hostname: "example.com",
    port: 443,
    address: publicA.address,
    family: 4,
    signal: transport.requests[0]!.signal,
  });
  assert.notEqual(transport.requests[0]?.address, publicB.address);
});

test("pins a direct public address without calling DNS", async () => {
  const resolver = new FakeResolver([[publicB]]);
  const transport = new FakeTransport([{ statusCode: 200, chunks: [encoder.encode("<p>direct</p>")] }]);
  const result = await fetchCrawlPageWithDependencies(
    "https://93.184.216.34/resource",
    new AbortController().signal,
    dependencies(resolver, transport),
  );
  assert.deepEqual(resolver.calls, []);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.hostname, "93.184.216.34");
  assert.equal(transport.requests[0]?.port, 443);
  assert.equal(transport.requests[0]?.address, "93.184.216.34");
  assert.equal(transport.requests[0]?.family, 4);
  assert.equal(result.requestedUrl, "https://93.184.216.34/resource");
  assert.equal(result.finalUrl, result.requestedUrl);
  assert.equal(result.redirectCount, 0);
});

test("follows a relative redirect with a fresh resolve and a new pin", async () => {
  const resolver = new FakeResolver([[publicA], [publicB]]);
  const transport = new FakeTransport([
    { statusCode: 302, location: ["../next?q=1#ignored"], chunks: [encoder.encode(MARKER)], contentType: "text/plain" },
    { statusCode: 200, chunks: [encoder.encode("<p>next</p>")], contentType: "text/html" },
  ]);
  const result = await fetchCrawlPageWithDependencies(
    "https://example.com/start",
    new AbortController().signal,
    dependencies(resolver, transport),
  );
  assert.deepEqual(resolver.calls, ["example.com", "example.com"]);
  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[0]?.address, publicA.address);
  assert.equal(transport.requests[1]?.address, publicB.address);
  assert.equal(transport.requests[1]?.url, "https://example.com/next?q=1");
  assert.equal(transport.requests[1]?.port, 443);
  assert.deepEqual(transport.cancelCalls, [0]);
  assert.equal(result.bodyText, "<p>next</p>");
  assert.equal(result.bodyText.includes(MARKER), false);
  assert.equal(result.redirectCount, 1);
  assert.equal(result.finalUrl, "https://example.com/next?q=1");
  assert.equal(result.requestedUrl, "https://example.com/start");
});

test("follows a cross-host redirect and pins the new host", async () => {
  const resolver = new FakeResolver([[publicA], [publicC]]);
  const transport = new FakeTransport([
    { statusCode: 301, location: ["https://WWW.Other.EXAMPLE/final#x"] },
    { statusCode: 200, chunks: [encoder.encode("landed")], contentType: "Application/XHTML+XML" },
  ]);
  const result = await fetchCrawlPageWithDependencies(
    "http://example.com/from",
    new AbortController().signal,
    dependencies(resolver, transport),
  );
  assert.deepEqual(resolver.calls, ["example.com", "www.other.example"]);
  assert.equal(transport.requests[0]?.port, 80);
  assert.equal(transport.requests[0]?.address, publicA.address);
  assert.equal(transport.requests[1]?.hostname, "www.other.example");
  assert.equal(transport.requests[1]?.port, 443);
  assert.equal(transport.requests[1]?.address, publicC.address);
  assert.equal(result.finalUrl, "https://www.other.example/final");
  assert.equal(result.contentType, "application/xhtml+xml");
  assert.equal(result.bodyText, "landed");
  assert.equal(result.redirectCount, 1);
});

test("follows 303, 307, and 308 once each", async () => {
  for (const statusCode of [303, 307, 308]) {
    const resolver = new FakeResolver([[publicA], [publicB]]);
    const transport = new FakeTransport([
      { statusCode, location: ["/next"] },
      { statusCode: 200, chunks: [encoder.encode("ok")] },
    ]);
    const result = await fetchCrawlPageWithDependencies(
      "https://example.com/start",
      new AbortController().signal,
      dependencies(resolver, transport),
    );
    assert.equal(result.finalUrl, "https://example.com/next");
    assert.equal(result.redirectCount, 1);
    assert.equal(transport.requests.length, 2);
  }
});

test("allows HTTP to HTTPS after revalidation", async () => {
  const resolver = new FakeResolver([[publicA], [publicB]]);
  const transport = new FakeTransport([
    { statusCode: 302, location: ["https://example.com/secure"] },
    { statusCode: 200, chunks: [encoder.encode("secure")] },
  ]);
  const result = await fetchCrawlPageWithDependencies(
    "http://example.com/plain",
    new AbortController().signal,
    dependencies(resolver, transport),
  );
  assert.equal(transport.requests[0]?.port, 80);
  assert.equal(transport.requests[1]?.port, 443);
  assert.equal(transport.requests[1]?.address, publicB.address);
  assert.equal(result.finalUrl, "https://example.com/secure");
  assert.equal(result.bodyText, "secure");
});

test("blocks HTTPS to HTTP before the next connection", async () => {
  const resolver = new FakeResolver([[publicA], [publicB]]);
  const transport = new FakeTransport([
    { statusCode: 302, location: [`http://example.com/${MARKER}`], chunks: [encoder.encode(MARKER)] },
    { statusCode: 200, chunks: [encoder.encode("should-not-run")] },
  ]);
  await assert.rejects(
    fetchCrawlPageWithDependencies("https://example.com/start", new AbortController().signal, dependencies(resolver, transport)),
    (error: unknown) => crawlFailure(error, "REDIRECT_DOWNGRADE", [MARKER, "example.com", "http://"]),
  );
  assert.deepEqual(resolver.calls, ["example.com", "example.com"]);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.port, 443);
  assert.deepEqual(transport.cancelCalls, [0]);
  assert.equal(transport.bodyReads, 0);
});

test("blocks an unsafe redirect without the next transport call", async () => {
  const resolver = new FakeResolver([[publicA], [{ address: "127.0.0.1", family: 4 }]]);
  const transport = new FakeTransport([
    { statusCode: 302, location: [`https://${MARKER}/rebind`] },
    { statusCode: 200 },
  ]);
  await assert.rejects(
    fetchCrawlPageWithDependencies("https://example.com/start", new AbortController().signal, dependencies(resolver, transport)),
    (error: unknown) => networkFailure(error, "BLOCKED_ADDRESS", [MARKER, "127.0.0.1", "example.com"]),
  );
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.cancelCalls, [0]);
});

test("propagates an invalid redirect location unchanged", async () => {
  const cases: readonly [string, NetworkTargetErrorCode][] = [
    [`https://user:${MARKER}@example.com/next`, "CREDENTIALS_NOT_ALLOWED"],
    [`https://example.com:8443/${MARKER}`, "PORT_NOT_ALLOWED"],
    ["http://127.0.0.1/next", "BLOCKED_ADDRESS"],
    ["javascript:alert(1)", "UNSUPPORTED_SCHEME"],
  ];
  for (const [location, code] of cases) {
    const resolver = new FakeResolver([[publicA]]);
    const transport = new FakeTransport([
      { statusCode: 302, location: [location], chunks: [encoder.encode(MARKER)] },
      { statusCode: 200 },
    ]);
    await assert.rejects(
      fetchCrawlPageWithDependencies("https://example.com/start", new AbortController().signal, dependencies(resolver, transport)),
      (error: unknown) => networkFailure(error, code, [MARKER, "127.0.0.1", "8443", "javascript"]),
    );
    assert.equal(transport.requests.length, 1);
  }
});

test("allows five redirects and rejects the sixth", async () => {
  const allowedLocations = ["/1", "/2", "/3", "/4", "/5"];
  const resolver = new FakeResolver([[publicA]]);
  const transport = new FakeTransport([
    ...allowedLocations.map((location) => ({ statusCode: 302, location: [location], chunks: [encoder.encode(MARKER)] })),
    { statusCode: 200, chunks: [encoder.encode("final")], contentType: "text/html" },
  ]);
  const result = await fetchCrawlPageWithDependencies(
    "https://example.com/0",
    new AbortController().signal,
    dependencies(resolver, transport),
  );
  assert.equal(result.redirectCount, 5);
  assert.equal(result.requestedUrl, "https://example.com/0");
  assert.equal(result.finalUrl, "https://example.com/5");
  assert.equal(result.bodyText, "final");
  assert.equal(transport.requests.length, 6);
  assert.equal(resolver.calls.length, 6);

  const limited = new FakeTransport(
    ["/1", "/2", "/3", "/4", "/5", "/6"].map((location) => ({
      statusCode: 302,
      location: [location],
      chunks: [encoder.encode(MARKER)],
    })),
  );
  const limitedResolver = new FakeResolver([[publicA]]);
  await assert.rejects(
    fetchCrawlPageWithDependencies("https://example.com/0", new AbortController().signal, dependencies(limitedResolver, limited)),
    (error: unknown) => crawlFailure(error, "REDIRECT_LIMIT", [MARKER, "example.com"]),
  );
  assert.equal(limited.requests.length, 6);
  assert.equal(limitedResolver.calls.length, 6);
  assert.equal(limited.bodyReads, 0);
  assert.deepEqual(limited.cancelCalls, [0, 1, 2, 3, 4, 5]);
});

test("rejects missing and duplicate redirect locations", async () => {
  for (const location of [[], ["https://example.com/a", `https://${MARKER}/b`]] as const) {
    const resolver = new FakeResolver([[publicA]]);
    const transport = new FakeTransport([
      { statusCode: 302, location, chunks: [encoder.encode(MARKER)] },
      { statusCode: 200, chunks: [encoder.encode("nope")] },
    ]);
    await assert.rejects(
      fetchCrawlPageWithDependencies("https://example.com/start", new AbortController().signal, dependencies(resolver, transport)),
      (error: unknown) => crawlFailure(error, "HTTP_FAILURE", [MARKER, "example.com", "302"]),
    );
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.bodyReads, 0);
    assert.deepEqual(resolver.calls, ["example.com"]);
  }
});

test("does not follow 300, 304, 305, 306, 404, or 500", async () => {
  for (const statusCode of [300, 304, 305, 306, 404, 500]) {
    const resolver = new FakeResolver([[publicA]]);
    const transport = new FakeTransport([{
      statusCode,
      location: [`https://${MARKER}/next`],
      chunks: [encoder.encode(`${MARKER} body ${statusCode}`)],
      contentType: "text/html",
    }]);
    await assert.rejects(
      fetchCrawlPageWithDependencies(`https://${MARKER}/page`, new AbortController().signal, dependencies(resolver, transport)),
      (error: unknown) => crawlFailure(error, "HTTP_FAILURE", [MARKER, String(statusCode), "body"]),
    );
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.bodyReads, 0);
  }
});

test("does not return a redirect body", async () => {
  const resolver = new FakeResolver([[publicA], [publicB]]);
  const transport = new FakeTransport([
    { statusCode: 302, location: ["/next"], chunks: [encoder.encode(`redirect ${MARKER}`)] },
    { statusCode: 200, chunks: [encoder.encode("page")] },
  ]);
  const result = await fetchCrawlPageWithDependencies(
    "https://example.com/start",
    new AbortController().signal,
    dependencies(resolver, transport),
  );
  assert.equal(result.bodyText, "page");
  assert.equal(transport.bodyReads, 1);
  assert.deepEqual(transport.cancelCalls, [0]);
});

test("keeps a 200 location as page content instead of another hop", async () => {
  const resolver = new FakeResolver([[publicA]]);
  const transport = new FakeTransport([{
    statusCode: 200,
    location: ["https://example.com/other"],
    chunks: [encoder.encode("stay")],
  }]);
  const result = await fetchCrawlPageWithDependencies(
    "https://example.com/here",
    new AbortController().signal,
    dependencies(resolver, transport),
  );
  assert.equal(transport.requests.length, 1);
  assert.equal(result.bodyText, "stay");
  assert.equal(result.redirectCount, 0);
  assert.equal(result.finalUrl, "https://example.com/here");
});

test("accepts only UTF-8 HTML and XHTML content types", async () => {
  const accepted = [
    "text/html",
    "TEXT/HTML",
    " text/html ",
    "text/html; charset=utf-8",
    "text/html;charset=UTF-8",
    "text/html; charset=\"utf-8\"",
    "text/html; charset='utf8'",
    "application/xhtml+xml",
    "Application/XHTML+XML; charset=UTF8",
  ] as const;
  for (const contentType of accepted) {
    const resolver = new FakeResolver([[publicA]]);
    const transport = new FakeTransport([{ statusCode: 200, contentType, chunks: [encoder.encode("ok")] }]);
    const result = await fetchCrawlPageWithDependencies(
      "https://example.com/",
      new AbortController().signal,
      dependencies(resolver, transport),
    );
    assert.equal(result.bodyText, "ok");
    assert.ok(result.contentType === "text/html" || result.contentType === "application/xhtml+xml");
    assert.equal(result.contentType, contentType.toLowerCase().split(";", 1)[0]?.trim());
  }

  const rejected = [
    null,
    "",
    "text/plain",
    "application/json",
    "text/html; charset=iso-8859-1",
    "text/html; charset=utf-16",
    "text/html; boundary=x",
    "text/html; charset=utf-8; foo=bar",
    `text/html; marker=${MARKER}`,
  ] as const;
  for (const contentType of rejected) {
    const resolver = new FakeResolver([[publicA]]);
    const transport = new FakeTransport([{
      statusCode: 200,
      contentType,
      chunks: [encoder.encode(`<meta charset="iso-8859-1">${MARKER}`)],
    }]);
    await assert.rejects(
      fetchCrawlPageWithDependencies("https://example.com/", new AbortController().signal, dependencies(resolver, transport)),
      (error: unknown) => crawlFailure(error, "UNSUPPORTED_CONTENT_TYPE", [MARKER, "iso-8859-1", "json", "text/plain"]),
    );
    assert.equal(transport.bodyReads, 0);
  }
});

test("accepts only an absent or identity content encoding", async () => {
  for (const contentEncoding of [null, "identity", "IDENTITY", " identity "]) {
    const resolver = new FakeResolver([[publicA]]);
    const transport = new FakeTransport([{ statusCode: 200, contentEncoding, chunks: [encoder.encode("plain")] }]);
    const result = await fetchCrawlPageWithDependencies(
      "https://example.com/",
      new AbortController().signal,
      dependencies(resolver, transport),
    );
    assert.equal(result.bodyText, "plain");
  }

  for (const contentEncoding of ["gzip", "br", "deflate", "gzip, deflate", "identity, gzip", "", `gzip; ${MARKER}`]) {
    const resolver = new FakeResolver([[publicA]]);
    const transport = new FakeTransport([{
      statusCode: 200,
      contentEncoding,
      chunks: [encoder.encode(MARKER)],
    }]);
    await assert.rejects(
      fetchCrawlPageWithDependencies("https://example.com/", new AbortController().signal, dependencies(resolver, transport)),
      (error: unknown) => crawlFailure(error, "UNSUPPORTED_CONTENT_ENCODING", [MARKER, "gzip", "br", "deflate"]),
    );
    assert.equal(transport.bodyReads, 0);
  }
});

test("enforces the byte cap from Content-Length and from the bytes read", async () => {
  const exact = new Uint8Array(MAX_CRAWL_BODY_BYTES).fill(0x61);
  const resolver = new FakeResolver([[publicA]]);
  const exactTransport = new FakeTransport([{
    statusCode: 200,
    contentLength: String(MAX_CRAWL_BODY_BYTES),
    chunks: [exact],
  }]);
  const exactResult = await fetchCrawlPageWithDependencies(
    "https://example.com/",
    new AbortController().signal,
    dependencies(resolver, exactTransport),
  );
  assert.equal(exactResult.byteLength, MAX_CRAWL_BODY_BYTES);
  assert.equal(exactResult.bodyText.length, MAX_CRAWL_BODY_BYTES);

  const declared = new FakeTransport([{
    statusCode: 200,
    contentLength: String(MAX_CRAWL_BODY_BYTES + 1),
    chunks: [encoder.encode(MARKER)],
  }]);
  await assert.rejects(
    fetchCrawlPageWithDependencies("https://example.com/", new AbortController().signal, dependencies(new FakeResolver([[publicA]]), declared)),
    (error: unknown) => crawlFailure(error, "RESPONSE_TOO_LARGE", [MARKER, "1048577"]),
  );
  assert.equal(declared.bodyReads, 0);

  for (const contentLength of [null, "1", "10"] as const) {
    const streamed = new FakeTransport([{
      statusCode: 200,
      contentLength,
      chunks: [new Uint8Array(MAX_CRAWL_BODY_BYTES), new Uint8Array([0x61])],
    }]);
    await assert.rejects(
      fetchCrawlPageWithDependencies("https://example.com/", new AbortController().signal, dependencies(new FakeResolver([[publicA]]), streamed)),
      (error: unknown) => crawlFailure(error, "RESPONSE_TOO_LARGE", [MARKER]),
    );
    assert.equal(streamed.bodyReads, 1);
  }
});

test("rejects a malformed or duplicate Content-Length", async () => {
  for (const contentLength of ["01", "1.5", "-1", "10, 11", "", " 10", "10 ", "abc", `${MARKER}`]) {
    const transport = new FakeTransport([{ statusCode: 200, contentLength, chunks: [encoder.encode("x")] }]);
    await assert.rejects(
      fetchCrawlPageWithDependencies("https://example.com/", new AbortController().signal, dependencies(new FakeResolver([[publicA]]), transport)),
      (error: unknown) => crawlFailure(
        error,
        "HTTP_FAILURE",
        contentLength.length === 0 ? [MARKER] : [MARKER, contentLength],
      ),
    );
    assert.equal(transport.bodyReads, 0);
  }
});

test("returns valid UTF-8, including an empty body, and rejects invalid UTF-8", async () => {
  const text = "café <meta charset=\"iso-8859-1\">";
  const bytes = encoder.encode(text);
  assert.ok(bytes.byteLength > text.length);
  const resolver = new FakeResolver([[publicA]]);
  const transport = new FakeTransport([{ statusCode: 200, chunks: [bytes.slice(0, 3), bytes.slice(3)], contentType: "text/html" }]);
  const result = await fetchCrawlPageWithDependencies(
    "HTTPS://Example.COM/path#frag",
    new AbortController().signal,
    dependencies(resolver, transport),
  );
  assert.equal(result.bodyText, text);
  assert.equal(result.byteLength, bytes.byteLength);
  assert.equal(result.contentType, "text/html");
  assert.equal(result.statusCode, 200);
  assert.equal(result.redirectCount, 0);
  assert.equal(result.requestedUrl, "https://example.com/path");
  assert.equal(result.finalUrl, "https://example.com/path");

  const emptyTransport = new FakeTransport([{ statusCode: 200, chunks: [], contentLength: "0" }]);
  const empty = await fetchCrawlPageWithDependencies(
    "https://example.com/empty",
    new AbortController().signal,
    dependencies(new FakeResolver([[publicA]]), emptyTransport),
  );
  assert.equal(empty.bodyText, "");
  assert.equal(empty.byteLength, 0);

  const invalid = new FakeTransport([{ statusCode: 200, chunks: [new Uint8Array([0xc3, 0x28])] }]);
  await assert.rejects(
    fetchCrawlPageWithDependencies(`https://${MARKER}/`, new AbortController().signal, dependencies(new FakeResolver([[publicA]]), invalid)),
    (error: unknown) => crawlFailure(error, "INVALID_BODY", [MARKER, "c3"]),
  );
});

test("returns one frozen result and no transport metadata", async () => {
  const resolver = new FakeResolver([[publicA], [publicB]]);
  const transport = new FakeTransport([
    { statusCode: 302, location: ["https://www.example.com/done"] },
    { statusCode: 200, chunks: [encoder.encode("done")], contentType: "text/html; charset=utf-8" },
  ]);
  const caller = new AbortController();
  const result = await fetchCrawlPageWithDependencies(
    "https://example.com/start",
    caller.signal,
    dependencies(resolver, transport),
  );
  const expected: CrawlPageResult = {
    requestedUrl: "https://example.com/start",
    finalUrl: "https://www.example.com/done",
    statusCode: 200,
    contentType: "text/html",
    bodyText: "done",
    byteLength: 4,
    redirectCount: 1,
  };
  assert.deepEqual(result, expected);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(expected).sort());
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => {
    (result as { bodyText: string }).bodyText = MARKER;
  });
  assert.equal(JSON.stringify(result).includes(publicA.address), false);
  assert.equal(JSON.stringify(result).includes("set-cookie"), false);
});

test("cancels a caller abort during DNS and does not connect afterwards", async () => {
  let release: ((value: readonly DnsAddressRecord[]) => void) | undefined;
  const calls: string[] = [];
  const resolver: DnsResolver = {
    async resolve(hostname: string): Promise<readonly DnsAddressRecord[]> {
      calls.push(hostname);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const transport = new FakeTransport([{ statusCode: 200 }]);
  const caller = new AbortController();
  const pending = fetchCrawlPageWithDependencies(
    `https://${MARKER}/`,
    caller.signal,
    dependencies(resolver, transport, 5_000),
  );
  await settle(0);
  assert.deepEqual(calls, [MARKER]);
  caller.abort(new Error(`reason ${MARKER}`));
  await rejectedSoon(pending, (error) => crawlFailure(error, "CANCELLED", [MARKER, "reason"]));
  release?.([publicA]);
  await settle(20);
  assert.deepEqual(transport.requests, []);
});

test("cancels an in-flight connection and an in-flight body", async () => {
  const beforeConnect = new FakeTransport([{ statusCode: 200, hangRequest: true }]);
  const caller = new AbortController();
  const pending = fetchCrawlPageWithDependencies(
    "https://example.com/",
    caller.signal,
    dependencies(new FakeResolver([[publicA]]), beforeConnect, 5_000),
  );
  await settle(0);
  assert.equal(beforeConnect.requests.length, 1);
  assert.notEqual(beforeConnect.requests[0]?.signal, caller.signal);
  caller.abort(new Error(MARKER));
  await rejectedSoon(pending, (error) => crawlFailure(error, "CANCELLED", [MARKER, "example.com"]));
  assert.equal(beforeConnect.requests[0]?.signal.aborted, true);
  assert.equal(beforeConnect.requests.length, 1);

  const duringBody = new FakeTransport([{ statusCode: 200, hangBody: true, chunks: [encoder.encode(MARKER)] }]);
  const bodyCaller = new AbortController();
  const bodyPending = fetchCrawlPageWithDependencies(
    "https://example.com/",
    bodyCaller.signal,
    dependencies(new FakeResolver([[publicA]]), duringBody, 5_000),
  );
  await settle(0);
  assert.equal(duringBody.bodyReads, 1);
  bodyCaller.abort(new Error(`body ${MARKER}`));
  await rejectedSoon(bodyPending, (error) => crawlFailure(error, "CANCELLED", [MARKER, "body"]));
  assert.deepEqual(duringBody.cancelCalls, [0]);
});

test("distinguishes deadline expiry from caller cancellation", async () => {
  const hanging = new FakeTransport([{ statusCode: 200, hangRequest: true }]);
  await rejectedSoon(
    fetchCrawlPageWithDependencies(
      `https://${MARKER}/`,
      new AbortController().signal,
      dependencies(new FakeResolver([[publicA]]), hanging, 20),
    ),
    (error) => crawlFailure(error, "TIMEOUT", [MARKER]),
  );
  assert.equal(hanging.requests.length, 1);
  assert.equal(hanging.requests[0]?.signal.aborted, true);

  let release: ((value: readonly DnsAddressRecord[]) => void) | undefined;
  const resolver: DnsResolver = {
    async resolve(): Promise<readonly DnsAddressRecord[]> {
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const lateTransport = new FakeTransport([{ statusCode: 200 }]);
  const timed = fetchCrawlPageWithDependencies(
    "https://example.com/",
    new AbortController().signal,
    dependencies(resolver, lateTransport, 20),
  );
  await rejectedSoon(timed, (error) => crawlFailure(error, "TIMEOUT", ["example.com"]));
  release?.([publicA]);
  await settle(20);
  assert.deepEqual(lateTransport.requests, []);
});

test("uses one deadline for DNS and later hops", async () => {
  const resolver = new FakeResolver([[publicA], [publicB]]);
  const originalResolve = resolver.resolve.bind(resolver);
  resolver.resolve = async (hostname: string) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return originalResolve(hostname);
  };
  const transport = new FakeTransport([
    { statusCode: 302, location: ["https://example.com/next"] },
    { statusCode: 200, chunks: [encoder.encode("too-late")] },
  ]);
  await rejectedSoon(
    fetchCrawlPageWithDependencies(
      "https://example.com/start",
      new AbortController().signal,
      dependencies(resolver, transport, 70),
    ),
    (error) => crawlFailure(error, "TIMEOUT", ["example.com"]),
  );
  await settle(80);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.address, publicA.address);
});

test("still reports the original error when cleanup throws or never settles", async () => {
  const throwing = new FakeTransport([{
    statusCode: 200,
    contentLength: String(MAX_CRAWL_BODY_BYTES + 1),
    cancel: () => {
      throw new Error(`cleanup ${MARKER}`);
    },
  }]);
  await rejectedSoon(
    fetchCrawlPageWithDependencies("https://example.com/", new AbortController().signal, dependencies(new FakeResolver([[publicA]]), throwing)),
    (error) => crawlFailure(error, "RESPONSE_TOO_LARGE", [MARKER, "cleanup"]),
  );
  assert.deepEqual(throwing.cancelCalls, [0]);

  const hangingCancel = new FakeTransport([{
    statusCode: 200,
    chunks: [new Uint8Array(MAX_CRAWL_BODY_BYTES + 1)],
    cancel: () => new Promise(() => undefined),
  }]);
  await rejectedSoon(
    fetchCrawlPageWithDependencies("https://example.com/", new AbortController().signal, dependencies(new FakeResolver([[publicA]]), hangingCancel)),
    (error) => crawlFailure(error, "RESPONSE_TOO_LARGE", [MARKER]),
  );

  const hangingTimeout = new FakeTransport([{
    statusCode: 200,
    hangBody: true,
    cancel: () => new Promise(() => undefined),
  }]);
  await rejectedSoon(
    fetchCrawlPageWithDependencies(
      `https://${MARKER}/`,
      new AbortController().signal,
      dependencies(new FakeResolver([[publicA]]), hangingTimeout, 20),
    ),
    (error) => crawlFailure(error, "TIMEOUT", [MARKER]),
  );
  assert.deepEqual(hangingTimeout.cancelCalls, [0]);
});

test("refuses a timeout above the 15 second ceiling before any I/O", async () => {
  for (const timeoutMilliseconds of [0, -1, 1.5, Number.NaN, 15_001, 90_000]) {
    const resolver = new FakeResolver([[publicA]]);
    const transport = new FakeTransport([{ statusCode: 200 }]);
    await assert.rejects(
      () => fetchCrawlPageWithDependencies(
        `https://${MARKER}/`,
        new AbortController().signal,
        dependencies(resolver, transport, timeoutMilliseconds),
      ),
      (error: unknown) => error instanceof TypeError && error.message === "Crawl timeout is invalid." && !error.message.includes(MARKER),
    );
    assert.deepEqual(resolver.calls, []);
    assert.deepEqual(transport.requests, []);
  }

  const transport = new FakeTransport([{ statusCode: 200, chunks: [encoder.encode("ceiling")] }]);
  const result = await fetchCrawlPageWithDependencies(
    "https://93.184.216.34/",
    new AbortController().signal,
    dependencies(new FakeResolver([[publicB]]), transport, 15_000),
  );
  assert.equal(result.bodyText, "ceiling");
  assert.equal(transport.requests.length, 1);
});
