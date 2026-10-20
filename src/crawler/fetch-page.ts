import {
  createNodeDnsResolver,
  NetworkTargetError,
  resolveSafeRedirect,
  resolveSafeTarget,
  type DnsResolver,
  type SafeNetworkTarget,
} from "../network-safety";
import {
  CRAWL_PAGE_TIMEOUT_MILLISECONDS,
  MAX_CRAWL_BODY_BYTES,
  MAX_CRAWL_REDIRECTS,
  type CrawlPageContentType,
  type CrawlPageResult,
} from "./domain";
import { CrawlPageError } from "./errors";
import { createNodeCrawlTransport } from "./node-transport";

export type CrawlResponseHeaders = Readonly<{
  location: readonly string[];
  contentType: string | null;
  contentLength: string | null;
  contentEncoding: string | null;
}>;

export type CrawlTransportResponse = Readonly<{
  statusCode: number;
  headers: CrawlResponseHeaders;
  body: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}>;

export type CrawlTransportRequest = Readonly<{
  target: SafeNetworkTarget;
  pinnedAddress: Readonly<{ address: string; family: 4 | 6 }>;
  signal: AbortSignal;
}>;

export interface CrawlPageTransport {
  request(request: CrawlTransportRequest): Promise<CrawlTransportResponse>;
}

type CrawlDependencies = Readonly<{
  resolver: DnsResolver;
  transport: CrawlPageTransport;
  timeoutMilliseconds?: number;
}>;

type StopFlags = Readonly<{
  callerCancelled: boolean;
  timedOut: boolean;
}>;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function resolveTimeout(value: number | undefined): number {
  if (value === undefined) {
    return CRAWL_PAGE_TIMEOUT_MILLISECONDS;
  }
  if (!Number.isInteger(value) || value < 1 || value > CRAWL_PAGE_TIMEOUT_MILLISECONDS) {
    throw new TypeError("Crawl timeout is invalid.");
  }
  return value;
}

function stoppedError(flags: StopFlags): CrawlPageError | undefined {
  if (flags.callerCancelled) {
    return new CrawlPageError("CANCELLED");
  }
  if (flags.timedOut) {
    return new CrawlPageError("TIMEOUT");
  }
  return undefined;
}

function assertRunning(flags: StopFlags): void {
  const error = stoppedError(flags);
  if (error !== undefined) {
    throw error;
  }
}

function failureFrom(error: unknown, flags: StopFlags): Error {
  const stopped = stoppedError(flags);
  if (stopped !== undefined) {
    return stopped;
  }
  if (error instanceof NetworkTargetError || error instanceof CrawlPageError) {
    return error;
  }
  return new CrawlPageError("NETWORK_FAILURE");
}

function cancelQuietly(response: CrawlTransportResponse | undefined): void {
  if (response === undefined) {
    return;
  }
  try {
    void Promise.resolve(response.cancel()).catch(() => undefined);
  } catch {
    // Cleanup must not replace the crawl error or keep the call open.
  }
}

async function raceApproved(
  pending: Promise<SafeNetworkTarget>,
  abortPromise: Promise<never>,
  flags: () => StopFlags,
): Promise<SafeNetworkTarget> {
  void pending.catch(() => undefined);
  let target: SafeNetworkTarget;
  try {
    target = await Promise.race([pending, abortPromise]);
  } catch (error) {
    throw failureFrom(error, flags());
  }
  assertRunning(flags());
  return target;
}

async function raceResponse(
  pending: Promise<CrawlTransportResponse>,
  abortPromise: Promise<never>,
  flags: () => StopFlags,
): Promise<CrawlTransportResponse> {
  void pending.catch(() => undefined);
  let response: CrawlTransportResponse;
  try {
    response = await Promise.race([pending, abortPromise]);
  } catch (error) {
    void pending.then((late) => cancelQuietly(late), () => undefined);
    throw failureFrom(error, flags());
  }
  try {
    assertRunning(flags());
  } catch (error) {
    cancelQuietly(response);
    throw error;
  }
  return response;
}

function assertIdentityEncoding(value: string | null): void {
  if (value === null) {
    return;
  }
  if (value.trim().toLowerCase() !== "identity") {
    throw new CrawlPageError("UNSUPPORTED_CONTENT_ENCODING");
  }
}

function parseContentType(value: string | null): CrawlPageContentType {
  if (value === null) {
    throw new CrawlPageError("UNSUPPORTED_CONTENT_TYPE");
  }
  const parts = value.split(";");
  const type = parts[0]?.trim().toLowerCase();
  if (type !== "text/html" && type !== "application/xhtml+xml") {
    throw new CrawlPageError("UNSUPPORTED_CONTENT_TYPE");
  }
  const parameters = parts.slice(1).map((part) => part.trim()).filter((part) => part.length > 0);
  if (parameters.length > 1) {
    throw new CrawlPageError("UNSUPPORTED_CONTENT_TYPE");
  }
  const parameter = parameters[0];
  if (parameter === undefined) {
    return type;
  }
  const separator = parameter.indexOf("=");
  const name = separator === -1 ? "" : parameter.slice(0, separator).trim().toLowerCase();
  let parameterValue = separator === -1 ? "" : parameter.slice(separator + 1).trim();
  if (name !== "charset" || parameterValue.length === 0) {
    throw new CrawlPageError("UNSUPPORTED_CONTENT_TYPE");
  }
  const quoted = (
    (parameterValue.startsWith("\"") && parameterValue.endsWith("\"") && parameterValue.length >= 2)
    || (parameterValue.startsWith("'") && parameterValue.endsWith("'") && parameterValue.length >= 2)
  );
  if (quoted) {
    parameterValue = parameterValue.slice(1, -1).trim();
  }
  const charset = parameterValue.toLowerCase();
  if (charset !== "utf-8" && charset !== "utf8") {
    throw new CrawlPageError("UNSUPPORTED_CONTENT_TYPE");
  }
  return type;
}

function assertContentLength(value: string | null): void {
  if (value === null) {
    return;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CrawlPageError("HTTP_FAILURE");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CrawlPageError("HTTP_FAILURE");
  }
  if (parsed > MAX_CRAWL_BODY_BYTES) {
    throw new CrawlPageError("RESPONSE_TOO_LARGE");
  }
}

async function readBody(
  body: AsyncIterable<Uint8Array>,
  abortPromise: Promise<never>,
  flags: () => StopFlags,
): Promise<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const pending = Promise.resolve(iterator.next());
    void pending.catch(() => undefined);
    let step: IteratorResult<Uint8Array>;
    try {
      step = await Promise.race([pending, abortPromise]);
    } catch (error) {
      throw failureFrom(error, flags());
    }
    assertRunning(flags());
    if (step.done === true) {
      break;
    }
    if (!(step.value instanceof Uint8Array)) {
      throw new CrawlPageError("NETWORK_FAILURE");
    }
    totalBytes += step.value.byteLength;
    if (totalBytes > MAX_CRAWL_BODY_BYTES) {
      throw new CrawlPageError("RESPONSE_TOO_LARGE");
    }
    chunks.push(step.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeBody(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CrawlPageError("INVALID_BODY");
  }
}

export async function fetchCrawlPageWithDependencies(
  input: unknown,
  signal: AbortSignal,
  dependencies: CrawlDependencies,
): Promise<CrawlPageResult> {
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError("Crawl signal is invalid.");
  }
  const timeoutMilliseconds = resolveTimeout(dependencies.timeoutMilliseconds);
  if (signal.aborted) {
    throw new CrawlPageError("CANCELLED");
  }

  const operation = new AbortController();
  let callerCancelled = false;
  let timedOut = false;
  const flags = (): StopFlags => ({ callerCancelled, timedOut });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    operation.signal.addEventListener("abort", () => {
      reject(stoppedError(flags()) ?? new CrawlPageError("CANCELLED"));
    }, { once: true });
  });
  void abortPromise.catch(() => undefined);
  const onCallerAbort = (): void => {
    callerCancelled = true;
    operation.abort();
  };
  signal.addEventListener("abort", onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    operation.abort();
  }, timeoutMilliseconds);

  try {
    let target = await raceApproved(
      resolveSafeTarget(input, dependencies.resolver),
      abortPromise,
      flags,
    );
    const requestedUrl = target.url;
    let redirectCount = 0;

    for (;;) {
      assertRunning(flags());
      const pinnedAddress = target.addresses[0];
      if (pinnedAddress === undefined) {
        throw new CrawlPageError("NETWORK_FAILURE");
      }
      const response = await raceResponse(
        dependencies.transport.request({
          target,
          pinnedAddress,
          signal: operation.signal,
        }),
        abortPromise,
        flags,
      );
      let deliver = false;
      try {
        if (REDIRECT_STATUSES.has(response.statusCode)) {
          if (redirectCount >= MAX_CRAWL_REDIRECTS) {
            throw new CrawlPageError("REDIRECT_LIMIT");
          }
          const locations = response.headers.location;
          const location = locations[0];
          if (!Array.isArray(locations) || locations.length !== 1 || typeof location !== "string") {
            throw new CrawlPageError("HTTP_FAILURE");
          }
          const next = await raceApproved(
            resolveSafeRedirect(target, location, dependencies.resolver),
            abortPromise,
            flags,
          );
          if (target.port === 443 && next.port === 80) {
            throw new CrawlPageError("REDIRECT_DOWNGRADE");
          }
          target = next;
          redirectCount += 1;
          continue;
        }
        if (response.statusCode !== 200) {
          throw new CrawlPageError("HTTP_FAILURE");
        }
        assertIdentityEncoding(response.headers.contentEncoding);
        const contentType = parseContentType(response.headers.contentType);
        assertContentLength(response.headers.contentLength);
        const bytes = await readBody(response.body, abortPromise, flags);
        const bodyText = decodeBody(bytes);
        deliver = true;
        const result: CrawlPageResult = {
          requestedUrl,
          finalUrl: target.url,
          statusCode: 200,
          contentType,
          bodyText,
          byteLength: bytes.byteLength,
          redirectCount,
        };
        return Object.freeze(result);
      } finally {
        if (!deliver) {
          cancelQuietly(response);
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onCallerAbort);
  }
}

export function fetchCrawlPage(input: unknown, signal: AbortSignal): Promise<CrawlPageResult> {
  return fetchCrawlPageWithDependencies(input, signal, {
    resolver: createNodeDnsResolver(),
    transport: createNodeCrawlTransport(),
  });
}
