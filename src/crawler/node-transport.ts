import {
  request as httpRequest,
  Agent as HttpAgent,
  type IncomingMessage,
  type RequestOptions as HttpRequestOptions,
} from "node:http";
import {
  request as httpsRequest,
  Agent as HttpsAgent,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import { connect as connectSocket, isIP, type LookupFunction } from "node:net";

import type {
  CrawlPageTransport,
  CrawlResponseHeaders,
  CrawlTransportRequest,
  CrawlTransportResponse,
} from "./fetch-page";

type NodeCrawlTransportOptions = Readonly<{
  connectPort?: number;
}>;

type CrawlAgent = HttpAgent | HttpsAgent;

function readConnectPort(options: NodeCrawlTransportOptions | undefined): number | undefined {
  if (options?.connectPort === undefined) {
    return undefined;
  }
  if (!Number.isInteger(options.connectPort) || options.connectPort < 1 || options.connectPort > 65_535) {
    throw new TypeError("Crawl connect port is invalid.");
  }
  return options.connectPort;
}

function headerValues(rawHeaders: readonly string[], name: string): string[] {
  const wanted = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const headerName = rawHeaders[index];
    if (headerName !== undefined && headerName.toLowerCase() === wanted) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function oneHeader(rawHeaders: readonly string[], name: string): string | null {
  const values = headerValues(rawHeaders, name);
  if (values.length === 0) {
    return null;
  }
  if (values.length === 1) {
    return values[0] ?? "";
  }
  return values.join(", ");
}

function projectHeaders(rawHeaders: readonly string[]): CrawlResponseHeaders {
  return Object.freeze({
    location: Object.freeze(headerValues(rawHeaders, "location")),
    contentType: oneHeader(rawHeaders, "content-type"),
    contentLength: oneHeader(rawHeaders, "content-length"),
    contentEncoding: oneHeader(rawHeaders, "content-encoding"),
  });
}

function requestPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function pinnedLookup(
  targetHostname: string,
  pinnedAddress: CrawlTransportRequest["pinnedAddress"],
): LookupFunction {
  return (hostname, options, callback) => {
    if (hostname !== targetHostname) {
      callback(new Error("Crawl lookup failed."), "");
      return;
    }
    if (options.all === true) {
      callback(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }]);
      return;
    }
    callback(null, pinnedAddress.address, pinnedAddress.family);
  };
}

function closeQuietly(...resources: Array<{ destroy: () => void } | undefined>): void {
  for (const resource of resources) {
    try {
      resource?.destroy();
    } catch {
      // Closing a failed socket must not replace the transport result.
    }
  }
}

export function createNodeCrawlTransport(options?: NodeCrawlTransportOptions): CrawlPageTransport {
  const connectPort = readConnectPort(options);
  return Object.freeze({
    request(request: CrawlTransportRequest): Promise<CrawlTransportResponse> {
      const { target, pinnedAddress, signal } = request;
      const secure = target.port === 443;
      const agent: CrawlAgent = secure
        ? new HttpsAgent({ keepAlive: false, maxSockets: 1 })
        : new HttpAgent({ keepAlive: false, maxSockets: 1 });
      if (connectPort !== undefined) {
        agent.createConnection = () => connectSocket({
          host: pinnedAddress.address,
          port: connectPort,
          family: pinnedAddress.family,
        });
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error: unknown): void => {
          if (settled) {
            return;
          }
          settled = true;
          closeQuietly(agent);
          reject(error instanceof Error ? error : new Error("Crawl request failed."));
        };
        const baseOptions = {
          hostname: target.hostname,
          port: target.port,
          method: "GET" as const,
          path: requestPath(target.url),
          headers: {
            Accept: "text/html, application/xhtml+xml",
            "Accept-Encoding": "identity",
          },
          lookup: pinnedLookup(target.hostname, pinnedAddress),
          family: pinnedAddress.family,
          autoSelectFamily: false as const,
          maxHeaderSize: 16_384,
          signal,
        };
        let clientRequest: ReturnType<typeof httpRequest> | undefined;
        const handleResponse = (incoming: IncomingMessage): void => {
          if (settled) {
            closeQuietly(incoming, clientRequest, agent);
            return;
          }
          settled = true;
          let closed = false;
          const close = (): void => {
            if (closed) {
              return;
            }
            closed = true;
            closeQuietly(incoming, clientRequest, agent);
          };
          resolve(Object.freeze({
            statusCode: incoming.statusCode ?? 0,
            headers: projectHeaders(incoming.rawHeaders),
            body: {
              [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
                const iterator = incoming[Symbol.asyncIterator]();
                return {
                  async next(): Promise<IteratorResult<Uint8Array>> {
                    try {
                      const step = await iterator.next();
                      if (step.done === true) {
                        close();
                        return { done: true, value: undefined };
                      }
                      const value = typeof step.value === "string" ? Buffer.from(step.value) : step.value;
                      return { done: false, value };
                    } catch (error) {
                      close();
                      throw error;
                    }
                  },
                  async return(): Promise<IteratorResult<Uint8Array>> {
                    close();
                    return { done: true, value: undefined };
                  },
                };
              },
            },
            cancel(): Promise<void> {
              close();
              return Promise.resolve();
            },
          }));
        };
        clientRequest = secure
          ? httpsRequest({
            ...baseOptions,
            agent: agent as HttpsAgent,
            rejectUnauthorized: true,
            ...(isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
          } satisfies HttpsRequestOptions & { autoSelectFamily: false }, handleResponse)
          : httpRequest({
            ...baseOptions,
            agent: agent as HttpAgent,
          } satisfies HttpRequestOptions & { autoSelectFamily: false }, handleResponse);
        clientRequest.on("error", fail);
        clientRequest.end();
      });
    },
  });
}
