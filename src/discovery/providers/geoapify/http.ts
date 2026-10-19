import {
  DiscoveryProviderError,
  MalformedDiscoveryResponseError,
} from "../../errors";

export const GEOAPIFY_GEOCODING_ENDPOINT = "https://api.geoapify.com/v1/geocode/search";
export const GEOAPIFY_PLACES_ENDPOINT = "https://api.geoapify.com/v2/places";
export const GEOAPIFY_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
export const MAX_GEOAPIFY_RESPONSE_BYTES = 1_048_576;

export type GeoapifyEndpoint = "geocode" | "places";

type RequestOptions = Readonly<{
  fetchImpl?: typeof fetch;
  timeoutMilliseconds?: number;
}>;

const ENDPOINTS: Readonly<Record<GeoapifyEndpoint, string>> = Object.freeze({
  geocode: GEOAPIFY_GEOCODING_ENDPOINT,
  places: GEOAPIFY_PLACES_ENDPOINT,
});

function statusError(status: number): DiscoveryProviderError {
  if (status >= 300 && status <= 399) return new DiscoveryProviderError("REDIRECT_REFUSED");
  if (status === 401 || status === 403) return new DiscoveryProviderError("ACCESS_DENIED");
  if (status === 429) return new DiscoveryProviderError("RATE_LIMITED");
  if (status >= 400 && status <= 499) return new DiscoveryProviderError("REQUEST_REJECTED");
  if (status >= 500 && status <= 599) return new DiscoveryProviderError("PROVIDER_UNAVAILABLE");
  return new DiscoveryProviderError("UNEXPECTED_STATUS");
}

function validateContentLength(value: string | null): void {
  if (value === null) return;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new MalformedDiscoveryResponseError("INVALID_ENVELOPE");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DiscoveryProviderError("RESPONSE_TOO_LARGE");
  }
  if (parsed > MAX_GEOAPIFY_RESPONSE_BYTES) {
    throw new DiscoveryProviderError("RESPONSE_TOO_LARGE");
  }
}

function validateContentType(value: string | null): void {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime !== "application/json" && mime !== "application/geo+json") {
    throw new MalformedDiscoveryResponseError("INVALID_CONTENT_TYPE");
  }
}

function operationError(callerCancelled: boolean, timedOut: boolean): DiscoveryProviderError {
  if (callerCancelled) return new DiscoveryProviderError("CANCELLED");
  if (timedOut) return new DiscoveryProviderError("TIMEOUT");
  return new DiscoveryProviderError("NETWORK_FAILURE");
}

export async function requestGeoapifyJson(
  endpoint: GeoapifyEndpoint,
  parameters: URLSearchParams,
  apiKey: string,
  callerSignal: AbortSignal,
  options: RequestOptions = {},
): Promise<unknown> {
  if (callerSignal.aborted) {
    throw new DiscoveryProviderError("CANCELLED");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? GEOAPIFY_REQUEST_TIMEOUT_MILLISECONDS;
  const operationController = new AbortController();
  let callerCancelled = false;
  let timedOut = false;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    operationController.signal.addEventListener(
      "abort",
      () => reject(operationError(callerCancelled, timedOut)),
      { once: true },
    );
  });
  const onCallerAbort = (): void => {
    callerCancelled = true;
    operationController.abort();
  };
  callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    operationController.abort();
  }, timeoutMilliseconds);

  try {
    const url = new URL(ENDPOINTS[endpoint]);
    url.search = parameters.toString();
    try {
      response = await Promise.race([
        fetchImpl(url.href, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "x-api-key": apiKey,
          },
          redirect: "manual",
          signal: operationController.signal,
        }),
        abortPromise,
      ]);
    } catch {
      throw operationError(callerCancelled, timedOut);
    }

    if (response.status !== 200) {
      throw statusError(response.status);
    }
    validateContentType(response.headers.get("content-type"));
    validateContentLength(response.headers.get("content-length"));
    if (response.body === null) {
      throw new MalformedDiscoveryResponseError("INVALID_JSON");
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), abortPromise]);
      } catch {
        throw operationError(callerCancelled, timedOut);
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new MalformedDiscoveryResponseError("INVALID_ENVELOPE");
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_GEOAPIFY_RESPONSE_BYTES) {
        throw new DiscoveryProviderError("RESPONSE_TOO_LARGE");
      }
      chunks.push(result.value);
    }

    const body = new Uint8Array(totalBytes);
    let position = 0;
    for (const chunk of chunks) {
      body.set(chunk, position);
      position += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new MalformedDiscoveryResponseError("INVALID_JSON");
    }
    try {
      const parsed: unknown = JSON.parse(text);
      completed = true;
      return parsed;
    } catch {
      throw new MalformedDiscoveryResponseError("INVALID_JSON");
    }
  } finally {
    clearTimeout(timeout);
    callerSignal.removeEventListener("abort", onCallerAbort);
    if (!completed) {
      try {
        const cancellation = reader !== undefined
          ? reader.cancel()
          : response?.body?.cancel();
        void cancellation?.catch(() => undefined);
      } catch {
        // The public error is determined by the original failure, never stream cleanup.
      }
    }
    try {
      reader?.releaseLock();
    } catch {
      // Releasing a failed reader must not replace the original operation result.
    }
  }
}
