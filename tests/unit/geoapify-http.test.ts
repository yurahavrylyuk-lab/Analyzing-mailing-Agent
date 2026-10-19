import { strict as assert } from "node:assert";
import { test } from "node:test";
import { clearTimeout as cancelScheduledTimeout, setTimeout as scheduleTimeout } from "node:timers";

import {
  MalformedDiscoveryResponseError,
  type MalformedDiscoveryResponseErrorCode,
} from "../../src/discovery";
import { DiscoveryProviderError } from "../../src/discovery/errors";
import {
  GEOAPIFY_GEOCODING_ENDPOINT,
  GEOAPIFY_PLACES_ENDPOINT,
  MAX_GEOAPIFY_RESPONSE_BYTES,
  requestGeoapifyJson,
} from "../../src/discovery/providers/geoapify/http";

const API_KEY = "synthetic-api-key";

function providerCode(error: unknown, code: string): boolean {
  assert.ok(error instanceof DiscoveryProviderError);
  assert.equal(error.code, code);
  assert.equal(error.message.includes(API_KEY), false);
  return true;
}

function jsonResponse(body = "{}", init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

test("malformed response errors preserve no-argument compatibility", () => {
  const error = new MalformedDiscoveryResponseError();

  assert.equal(error.name, "MalformedDiscoveryResponseError");
  assert.equal(error.message, "Discovery provider response is invalid.");
  assert.equal(error.code, undefined);
  assert.deepEqual(Object.keys(error), ["name"]);
});

test("malformed response errors expose only optional allowlisted codes", () => {
  const codes: readonly MalformedDiscoveryResponseErrorCode[] = [
    "INVALID_ENVELOPE",
    "INVALID_JSON",
    "INVALID_CONTENT_TYPE",
  ];

  for (const code of codes) {
    const error = new MalformedDiscoveryResponseError(code);
    assert.equal(error.code, code);
    assert.equal(error.message, "Discovery provider response is invalid.");
    assert.equal("cause" in error, false);
    assert.deepEqual(Object.keys(error).sort(), ["code", "name"]);
  }
});

test("HTTP helper sends one exact credential-safe GET to either fixed endpoint", async () => {
  for (const [endpoint, expected] of [
    ["geocode", GEOAPIFY_GEOCODING_ENDPOINT],
    ["places", GEOAPIFY_PLACES_ENDPOINT],
  ] as const) {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse();
    };
    const params = new URLSearchParams([["text", "Warsaw & injected=false"]]);
    assert.deepEqual(
      await requestGeoapifyJson(endpoint, params, API_KEY, new AbortController().signal, { fetchImpl }),
      {},
    );
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    const url = new URL(String(call.input));
    assert.equal(`${url.origin}${url.pathname}`, expected);
    assert.equal(url.searchParams.get("text"), "Warsaw & injected=false");
    assert.equal(url.href.includes(API_KEY), false);
    assert.equal(call.init?.method, "GET");
    assert.equal(call.init?.redirect, "manual");
    assert.ok(call.init?.signal instanceof AbortSignal);
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("x-api-key"), API_KEY);
    assert.equal([...headers.keys()].length, 2);
  }
});

test("HTTP helper maps statuses to fixed safe provider errors without retry", async () => {
  const cases = [
    [300, "REDIRECT_REFUSED"], [301, "REDIRECT_REFUSED"], [308, "REDIRECT_REFUSED"],
    [400, "REQUEST_REJECTED"], [401, "ACCESS_DENIED"], [403, "ACCESS_DENIED"],
    [404, "REQUEST_REJECTED"], [429, "RATE_LIMITED"], [500, "PROVIDER_UNAVAILABLE"],
    [503, "PROVIDER_UNAVAILABLE"], [201, "UNEXPECTED_STATUS"],
  ] as const;

  for (const [status, code] of cases) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("provider body secret", { status, statusText: "unsafe status" });
    };
    await assert.rejects(
      requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl }),
      (error: unknown) => providerCode(error, code),
    );
    assert.equal(calls, 1);
  }
});

test("HTTP helper accepts bounded JSON MIME bodies and rejects invalid content", async () => {
  for (const contentType of ["application/json", "application/json; charset=utf-8", "application/geo+json; profile=x"]) {
    const fetchImpl: typeof fetch = async () => jsonResponse('{"ok":true}', { headers: { "content-type": contentType } });
    assert.deepEqual(
      await requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl }),
      { ok: true },
    );
  }

  for (const contentType of [undefined, "text/json", "text/plain"]) {
    const fetchImpl: typeof fetch = async () => new Response("{}", {
      status: 200,
      headers: contentType === undefined ? {} : { "content-type": contentType },
    });
    await assert.rejects(
      requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl }),
      (error: unknown) => error instanceof MalformedDiscoveryResponseError && error.code === "INVALID_CONTENT_TYPE",
    );
  }

  for (const body of ["{", new Uint8Array([0xc3, 0x28])]) {
    const fetchImpl: typeof fetch = async () => new Response(body, { headers: { "content-type": "application/json" } });
    await assert.rejects(
      requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl }),
      (error: unknown) => error instanceof MalformedDiscoveryResponseError && error.code === "INVALID_JSON",
    );
  }
});

test("HTTP helper enforces declared and actual 1 MiB limits incrementally", async () => {
  const exactBody = `"${"a".repeat(MAX_GEOAPIFY_RESPONSE_BYTES - 2)}"`;
  const oversizedBody = `"${"a".repeat(MAX_GEOAPIFY_RESPONSE_BYTES - 1)}"`;
  assert.equal(Buffer.byteLength(exactBody), MAX_GEOAPIFY_RESPONSE_BYTES);
  const exactFetch: typeof fetch = async () => jsonResponse(exactBody, {
    headers: { "content-type": "application/json", "content-length": String(MAX_GEOAPIFY_RESPONSE_BYTES) },
  });
  assert.equal(
    (await requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl: exactFetch }) as string).length,
    MAX_GEOAPIFY_RESPONSE_BYTES - 2,
  );

  for (const fetchImpl of [
    (async () => jsonResponse("{}", { headers: { "content-type": "application/json", "content-length": String(MAX_GEOAPIFY_RESPONSE_BYTES + 1) } })) as typeof fetch,
    (async () => jsonResponse(oversizedBody)) as typeof fetch,
    (async () => jsonResponse(oversizedBody, { headers: { "content-type": "application/json", "content-length": "1" } })) as typeof fetch,
  ]) {
    await assert.rejects(
      requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl }),
      (error: unknown) => providerCode(error, "RESPONSE_TOO_LARGE"),
    );
  }
});

test("HTTP helper accepts a bounded decoded body larger than its compressed-style Content-Length", async () => {
  const body = '{"decoded":"body larger than encoded representation"}';
  assert.ok(Buffer.byteLength(body) > 8);
  const fetchImpl: typeof fetch = async () => jsonResponse(body, {
    headers: { "content-type": "application/json", "content-length": "8" },
  });

  assert.deepEqual(
    await requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl }),
    { decoded: "body larger than encoded representation" },
  );
});

test("HTTP helper safely maps network and stream failures and cancels failed bodies", async () => {
  const networkFetch: typeof fetch = async () => { throw new Error(`native ${API_KEY}`); };
  await assert.rejects(
    requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl: networkFetch }),
    (error: unknown) => providerCode(error, "NETWORK_FAILURE"),
  );

  const failedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      controller.error(new Error(`stream ${API_KEY}`));
    },
  });
  const streamFetch: typeof fetch = async () => new Response(failedStream, { headers: { "content-type": "application/json" } });
  await assert.rejects(
    requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl: streamFetch }),
    (error: unknown) => providerCode(error, "NETWORK_FAILURE"),
  );

  let cancelled = false;
  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_GEOAPIFY_RESPONSE_BYTES + 1)); },
    cancel() { cancelled = true; },
  });
  const oversizedFetch: typeof fetch = async () => new Response(oversizedStream, { headers: { "content-type": "application/json" } });
  await assert.rejects(
    requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl: oversizedFetch }),
    (error: unknown) => providerCode(error, "RESPONSE_TOO_LARGE"),
  );
  assert.equal(cancelled, true);
});

test("HTTP helper distinguishes caller cancellation from deadline before headers", async () => {
  const waitForAbort: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

  const caller = new AbortController();
  const cancelled = requestGeoapifyJson("places", new URLSearchParams(), API_KEY, caller.signal, { fetchImpl: waitForAbort, timeoutMilliseconds: 100 });
  caller.abort("unsafe reason");
  await assert.rejects(cancelled, (error: unknown) => providerCode(error, "CANCELLED"));

  await assert.rejects(
    requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl: waitForAbort, timeoutMilliseconds: 5 }),
    (error: unknown) => providerCode(error, "TIMEOUT"),
  );
});

test("HTTP helper applies its deadline while consuming a response body", async () => {
  let cancelled = false;
  let calls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull() { return new Promise(() => undefined); },
    cancel() { cancelled = true; },
  });
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(stream, { headers: { "content-type": "application/json" } });
  };
  const caller = new AbortController();
  const signal = caller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    listeners += 1;
    return add(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    listeners -= 1;
    return remove(...args);
  }) as AbortSignal["removeEventListener"];

  await assert.rejects(
    requestGeoapifyJson("places", new URLSearchParams(), API_KEY, signal, {
      fetchImpl,
      timeoutMilliseconds: 5,
    }),
    (error: unknown) => providerCode(error, "TIMEOUT"),
  );
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
  assert.equal(listeners, 0);
});

test("HTTP helper returns timeout promptly when body cancellation never settles", async () => {
  let cancellationInitiated = false;
  let calls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull() { return new Promise(() => undefined); },
    cancel() {
      cancellationInitiated = true;
      return new Promise(() => undefined);
    },
  });
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(stream, { headers: { "content-type": "application/json" } });
  };
  const caller = new AbortController();
  const signal = caller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    listeners += 1;
    return add(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    listeners -= 1;
    return remove(...args);
  }) as AbortSignal["removeEventListener"];

  const originalClearTimeout = globalThis.clearTimeout;
  let clearedTimers = 0;
  globalThis.clearTimeout = ((timeout) => {
    clearedTimers += 1;
    return originalClearTimeout(timeout);
  }) as typeof clearTimeout;
  let guard: ReturnType<typeof scheduleTimeout> | undefined;
  try {
    const operation = requestGeoapifyJson("places", new URLSearchParams(), API_KEY, signal, {
      fetchImpl,
      timeoutMilliseconds: 5,
    });
    const outcome = await Promise.race([
      operation.then(
        () => ({ type: "fulfilled" as const }),
        (error: unknown) => ({ type: "rejected" as const, error }),
      ),
      new Promise<{ type: "guard" }>((resolve) => {
        guard = scheduleTimeout(() => resolve({ type: "guard" }), 100);
      }),
    ]);

    assert.equal(outcome.type, "rejected");
    if (outcome.type === "rejected") {
      providerCode(outcome.error, "TIMEOUT");
    }
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
    if (guard !== undefined) cancelScheduledTimeout(guard);
  }

  assert.equal(cancellationInitiated, true);
  assert.equal(clearedTimers, 1);
  assert.equal(calls, 1);
  assert.equal(listeners, 0);
});

test("HTTP helper propagates cancellation during body and cleans timers and listeners", async () => {
  let streamCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() { return new Promise(() => undefined); },
    cancel() { streamCancelled = true; },
  });
  const fetchImpl: typeof fetch = async () => new Response(stream, { headers: { "content-type": "application/json" } });
  const caller = new AbortController();
  const signal = caller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    listeners += 1;
    return add(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    listeners -= 1;
    return remove(...args);
  }) as AbortSignal["removeEventListener"];

  const operation = requestGeoapifyJson("places", new URLSearchParams(), API_KEY, signal, { fetchImpl, timeoutMilliseconds: 50 });
  queueMicrotask(() => caller.abort());
  await assert.rejects(operation, (error: unknown) => providerCode(error, "CANCELLED"));
  assert.equal(streamCancelled, true);
  assert.equal(listeners, 0);

  let operationSignal: AbortSignal | undefined;
  const successFetch: typeof fetch = async (_input, init) => {
    operationSignal = init?.signal ?? undefined;
    return jsonResponse();
  };
  await requestGeoapifyJson("places", new URLSearchParams(), API_KEY, new AbortController().signal, { fetchImpl: successFetch, timeoutMilliseconds: 5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(operationSignal?.aborted, false);
});
