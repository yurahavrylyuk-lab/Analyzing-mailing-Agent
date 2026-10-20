import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test } from "node:test";

import { createNodeCrawlTransport } from "../../src/crawler/node-transport";

const logicalTarget = Object.freeze({
  url: "http://crawl-pin.invalid/",
  hostname: "crawl-pin.invalid",
  port: 80 as const,
  addresses: Object.freeze([
    Object.freeze({ address: "127.0.0.1", family: 4 as const }),
  ]),
});

function pinnedRequest(signal: AbortSignal): {
  target: typeof logicalTarget;
  pinnedAddress: { address: "127.0.0.1"; family: 4 };
  signal: AbortSignal;
} {
  return {
    target: logicalTarget,
    pinnedAddress: { address: "127.0.0.1", family: 4 },
    signal,
  };
}

async function listen(
  onConnection: (socket: Socket) => void,
  onRequest?: (request: IncomingMessage, response: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; port: number; sockets: Set<Socket>; connectionCount: () => number }> {
  let connectionCount = 0;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    onRequest?.(request, response);
  });
  server.on("connection", (socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    onConnection(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    sockets,
    connectionCount: () => connectionCount,
  };
}

async function waitForEmpty(sockets: Set<Socket>): Promise<void> {
  const started = Date.now();
  while (sockets.size > 0 && Date.now() - started < 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sockets.size, 0);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("pins the loopback socket and returns a redirect without following it", { timeout: 5_000 }, async () => {
  const seen: IncomingMessage[] = [];
  const bound = await listen(() => undefined, (request, response) => {
    seen.push(request);
    response.writeHead(302, { Location: "https://crawl-pin.invalid/next" });
    response.end("redirect-body");
  });

  try {
    const transport = createNodeCrawlTransport({ connectPort: bound.port });
    const response = await transport.request(pinnedRequest(new AbortController().signal));
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      chunks.push(chunk);
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bound.connectionCount(), 1);
    assert.equal(seen.length, 1);
    const request = seen[0];
    assert.ok(request !== undefined);
    assert.equal(request.headers.host, "crawl-pin.invalid");
    assert.equal(request.url, "/");
    const raw = request.rawHeaders.join("\n");
    assert.equal(raw.includes("127.0.0.1"), false);
    assert.equal(raw.includes(String(bound.port)), false);
    assert.equal(request.headers.accept, "text/html, application/xhtml+xml");
    assert.equal(request.headers["accept-encoding"], "identity");
    assert.equal(request.headers["user-agent"], undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.referer, undefined);
    assert.equal(response.statusCode, 302);
    assert.deepEqual(response.headers.location, ["https://crawl-pin.invalid/next"]);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "redirect-body");
    assert.equal(bound.connectionCount(), 1);

    await waitForEmpty(bound.sockets);
    await closeServer(bound.server);
  } finally {
    for (const socket of bound.sockets) {
      socket.destroy();
    }
    await closeServer(bound.server);
  }
});

test("aborts an accepted silent connection without waiting for the crawl deadline", { timeout: 5_000 }, async () => {
  const caller = new AbortController();
  const bound = await listen((socket) => {
    socket.resume();
    caller.abort();
  });

  try {
    const transport = createNodeCrawlTransport({ connectPort: bound.port });
    const started = Date.now();
    await assert.rejects(transport.request(pinnedRequest(caller.signal)));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `transport waited ${elapsed}ms`);
    assert.equal(bound.connectionCount(), 1);
    await waitForEmpty(bound.sockets);
    await closeServer(bound.server);
  } finally {
    caller.abort();
    for (const socket of bound.sockets) {
      socket.destroy();
    }
    await closeServer(bound.server);
  }
});
