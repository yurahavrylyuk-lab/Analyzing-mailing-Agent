import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createGeoapifyProvider,
  DiscoveryProviderError,
  MalformedDiscoveryResponseError,
  normalizeDiscoveryCriteria,
  type DiscoveryProviderErrorCode,
} from "../../src/discovery";
import {
  GEOAPIFY_CATEGORY_BY_QUERY,
  calculateGeoapifyNextOffset,
} from "../../src/discovery/providers/geoapify/geoapify-provider";
import {
  normalizeGeoapifyGeocodingResponse,
  normalizeGeoapifyPlacesResponse,
} from "../../src/discovery/providers/geoapify/normalization";

const PROVIDER_ERROR_MESSAGES: Readonly<Record<DiscoveryProviderErrorCode, string>> = {
  INVALID_REQUEST: "Discovery provider request is invalid.",
  UNSUPPORTED_QUERY: "Discovery query is not supported.",
  INVALID_CURSOR: "Discovery cursor is invalid.",
  LOCATION_NOT_FOUND: "Discovery location was not found.",
  LOCATION_AMBIGUOUS: "Discovery location is ambiguous.",
  UNSUPPORTED_LOCATION: "Discovery location is not supported.",
  ACCESS_DENIED: "Discovery provider access was denied.",
  RATE_LIMITED: "Discovery provider rate limit was reached.",
  REQUEST_REJECTED: "Discovery provider rejected the request.",
  PROVIDER_UNAVAILABLE: "Discovery provider is unavailable.",
  TIMEOUT: "Discovery provider request timed out.",
  CANCELLED: "Discovery provider request was cancelled.",
  REDIRECT_REFUSED: "Discovery provider redirect was refused.",
  NETWORK_FAILURE: "Discovery provider network request failed.",
  RESPONSE_TOO_LARGE: "Discovery provider response is too large.",
  UNEXPECTED_STATUS: "Discovery provider returned an unexpected status.",
};
const API_KEY = "synthetic-api-key";

function providerCode(error: unknown, code: DiscoveryProviderErrorCode): boolean {
  assert.ok(error instanceof DiscoveryProviderError);
  assert.equal(error.code, code);
  return true;
}

test("provider errors expose every allowlisted code with one fixed safe message", () => {
  for (const [code, message] of Object.entries(PROVIDER_ERROR_MESSAGES)) {
    const error = new DiscoveryProviderError(code as DiscoveryProviderErrorCode);

    assert.equal(error.name, "DiscoveryProviderError");
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error), JSON.stringify({ name: error.name, code }));
  }
});

test("provider errors cannot reflect request, credential, or native error data", () => {
  const secret = "synthetic-secret-never-reflect";
  const error = new DiscoveryProviderError("NETWORK_FAILURE");
  const exposed = `${error.name} ${error.code} ${error.message} ${JSON.stringify(error)}`;

  assert.equal(exposed.includes(secret), false);
  assert.deepEqual(Object.keys(error).sort(), ["code", "name"]);
});

function assertProviderError(action: () => unknown, code: DiscoveryProviderErrorCode): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DiscoveryProviderError);
    assert.equal(error.code, code);
    return true;
  });
}

function identity(osmType: unknown = "n", osmId: unknown = 123): Record<string, unknown> {
  return {
    sourcename: "openstreetmap",
    raw: { osm_type: osmType, osm_id: osmId },
  };
}

function feature(properties: unknown): Record<string, unknown> {
  return {
    type: "Feature",
    id: "untrusted-geoapify-id",
    geometry: { type: "Point", coordinates: [1, 2] },
    properties,
  };
}

function collection(features: readonly unknown[]): Record<string, unknown> {
  return { type: "FeatureCollection", features, ignored: "metadata" };
}

function createQueuedFetch(responses: readonly unknown[]): Readonly<{
  fetch: typeof fetch;
  calls: Array<{ url: URL; init?: RequestInit }>;
}> {
  const queue = [...responses];
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    if (queue.length === 0) throw new Error("Unexpected synthetic HTTP call");
    return new Response(JSON.stringify(queue.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchImpl, calls };
}

const CITY_RESPONSE = Object.freeze({
  results: [{ result_type: "city", place_id: "warsaw-area" }],
});

function searchRequest(
  query = "bakery",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    criteria: normalizeDiscoveryCriteria({ location: "Warsaw", query, maxResults: 20 }),
    pageSize: 2,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("geocoding accepts exactly one city and retains only a bounded area ID", () => {
  const response = {
    results: [{ result_type: "city", place_id: "city-Area_123", formatted: "discard" }],
    query: { text: "discard" },
  };
  assert.equal(normalizeGeoapifyGeocodingResponse(response), "city-Area_123");
});

test("geocoding distinguishes no result, ambiguity, and unsupported location", () => {
  assertProviderError(() => normalizeGeoapifyGeocodingResponse({ results: [] }), "LOCATION_NOT_FOUND");
  assertProviderError(
    () => normalizeGeoapifyGeocodingResponse({ results: [
      { result_type: "city", place_id: "one" },
      { result_type: "city", place_id: "two" },
    ] }),
    "LOCATION_AMBIGUOUS",
  );
  assertProviderError(
    () => normalizeGeoapifyGeocodingResponse({ results: [{ result_type: "district", place_id: "area" }] }),
    "UNSUPPORTED_LOCATION",
  );
});

test("geocoding rejects malformed envelopes, results, and area IDs", () => {
  for (const value of [
    null,
    [],
    {},
    { results: null },
    { results: [null] },
    { results: [{}] },
    { results: [{ result_type: "city" }] },
    { results: [{ result_type: "city", place_id: "" }] },
    { results: [{ result_type: "city", place_id: "bad area" }] },
    { results: [{ result_type: "city", place_id: "a".repeat(513) }] },
    { results: [
      { result_type: "city", place_id: "one" },
      { result_type: "city", place_id: "two" },
      { result_type: "city", place_id: "three" },
    ] },
  ]) {
    assert.throws(
      () => normalizeGeoapifyGeocodingResponse(value),
      (error: unknown) => error instanceof MalformedDiscoveryResponseError && error.code === "INVALID_ENVELOPE",
    );
  }
});

test("an oversized geocoding envelope prevents the Places request", async () => {
  const mock = createQueuedFetch([{ results: [
    { result_type: "city", place_id: "one" },
    { result_type: "city", place_id: "two" },
    { result_type: "city", place_id: "three" },
  ] }]);
  const provider = createGeoapifyProvider(
    { provider: "geoapify", apiKey: API_KEY },
    { fetch: mock.fetch },
  );

  await assert.rejects(
    provider.searchPage(searchRequest() as never),
    (error: unknown) =>
      error instanceof MalformedDiscoveryResponseError && error.code === "INVALID_ENVELOPE",
  );
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0]?.url.pathname, "/v1/geocode/search");
});

test("Places derives references only from valid OSM node, way, and relation identity", () => {
  const outcomes = normalizeGeoapifyPlacesResponse(collection([
    feature({ datasource: identity("n", 4944605520), name: "Node" }),
    feature({ datasource: identity("w", 123456), name: "Way" }),
    feature({ datasource: identity("r", 987654), name: "Relation" }),
  ]), 3);

  assert.deepEqual(outcomes.map((outcome) => outcome.status === "accepted" ? outcome.candidate.providerReference : outcome.code), [
    "osm:n:4944605520",
    "osm:w:123456",
    "osm:r:987654",
  ]);
  assert.equal(Object.isFrozen(outcomes), true);
  assert.equal(Object.isFrozen(outcomes[0]), true);
});

test("Places identity ignores Geoapify IDs and keeps OSM type in identity", () => {
  const outcomes = normalizeGeoapifyPlacesResponse(collection([
    { ...feature({ datasource: identity("n", 7), name: "First" }), id: "place-one" },
    { ...feature({ datasource: identity("n", 7), name: "Second" }), id: "place-two" },
    feature({ datasource: identity("w", 7), name: "Third" }),
  ]), 3);
  const references = outcomes.map((outcome) => outcome.status === "accepted" ? outcome.candidate.providerReference : "rejected");
  assert.deepEqual(references, ["osm:n:7", "osm:n:7", "osm:w:7"]);
});

test("every invalid OSM identity becomes one invalid_reference outcome without fallback", () => {
  const invalidDatasourceValues: unknown[] = [
    undefined,
    null,
    {},
    { sourcename: "other", raw: { osm_type: "n", osm_id: 1 } },
    { sourcename: "openstreetmap" },
    { sourcename: "openstreetmap", raw: null },
    identity("x", 1),
    identity("n", "1"),
    identity("n", 0),
    identity("n", -1),
    identity("n", 1.5),
    identity("n", Number.MAX_SAFE_INTEGER + 1),
  ];
  const features = [null, {}, feature(null), ...invalidDatasourceValues.map((datasource) => feature({
    datasource,
    name: "Fallback Name",
    place_id: "must-not-fallback",
  }))];
  assert.deepEqual(
    normalizeGeoapifyPlacesResponse(collection(features), 20),
    features.map(() => ({ status: "rejected", code: "invalid_reference" })),
  );
});

test("Places uses only properties.name and preserves name rejection slots", () => {
  const outcomes = normalizeGeoapifyPlacesResponse(collection([
    feature({ datasource: identity("n", 1), name: "  Trimmed Name  " }),
    feature({ datasource: identity("n", 2), name: "" }),
    feature({ datasource: identity("n", 3), name: 42, formatted: "Fallback" }),
    feature({ datasource: identity("n", 4), name: "bad\nname" }),
    feature({ datasource: identity("n", 5), name: "a".repeat(301) }),
  ]), 5);

  assert.equal(outcomes[0]?.status, "accepted");
  if (outcomes[0]?.status === "accepted") assert.equal(outcomes[0].candidate.businessName, "Trimmed Name");
  assert.deepEqual(outcomes.slice(1), Array.from({ length: 4 }, () => ({ status: "rejected", code: "invalid_business_name" })));
});

test("Places uses only properties.website and delegates storage normalization", () => {
  const outcomes = normalizeGeoapifyPlacesResponse(collection([
    feature({ datasource: identity("n", 1), name: "Missing", contact: { website: "https://ignored.example" } }),
    feature({ datasource: { ...identity("n", 2), raw: { ...(identity("n", 2).raw as object), website: "https://ignored.example" } }, name: "Null", website: null }),
    feature({ datasource: identity("n", 3), name: "Valid", website: " https://example.com/path " }),
    feature({ datasource: identity("n", 4), name: "Invalid", website: "javascript:alert(1)" }),
    feature({ datasource: identity("n", 5), name: "Oversized", website: `https://example.com/${"a".repeat(2049)}` }),
  ]), 5);

  assert.deepEqual(outcomes.map((outcome) => outcome.status === "accepted" ? outcome.candidate.websiteObservation : null), [
    { presence: "unknown" },
    { presence: "unknown" },
    { presence: "present", url: "https://example.com/path" },
    { presence: "unknown" },
    { presence: "unknown" },
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status === "accepted" ? outcome.warnings : []), [
    [], [], [], ["invalid_website"], ["invalid_website"],
  ]);
});

test("Places requires a bounded FeatureCollection and never truncates", () => {
  for (const value of [
    null,
    {},
    { type: "Feature", features: [] },
    { type: "FeatureCollection" },
    { type: "FeatureCollection", features: {} },
    collection([feature({ datasource: identity(), name: "one" }), feature({ datasource: identity(), name: "two" })]),
  ]) {
    assert.throws(
      () => normalizeGeoapifyPlacesResponse(value, 1),
      (error: unknown) => error instanceof MalformedDiscoveryResponseError && error.code === "INVALID_ENVELOPE",
    );
  }
});

test("provider construction performs no I/O and keeps credentials in private closure state", () => {
  const mock = createQueuedFetch([]);
  const provider = createGeoapifyProvider({ provider: "geoapify", apiKey: "private-synthetic-key" }, { fetch: mock.fetch });

  assert.equal(mock.calls.length, 0);
  assert.equal(provider.id, "geoapify");
  assert.deepEqual(Object.keys(provider).sort(), ["id", "searchPage"]);
  assert.equal(JSON.stringify(provider).includes("private-synthetic-key"), false);
  assert.equal(Object.isFrozen(provider), true);
});

test("provider validates the exact request envelope before any HTTP", async () => {
  const mock = createQueuedFetch([]);
  const provider = createGeoapifyProvider({ provider: "geoapify", apiKey: API_KEY }, { fetch: mock.fetch });
  const invalidRequests: unknown[] = [
    null,
    {},
    { ...searchRequest(), extra: true },
    { ...searchRequest(), signal: {} },
    { ...searchRequest(), pageSize: 0 },
    { ...searchRequest(), pageSize: 21 },
    { ...searchRequest(), pageSize: 1.5 },
    { ...searchRequest(), criteria: { location: "", query: "bakery", maxResults: 20 } },
  ];
  for (const request of invalidRequests) {
    await assert.rejects(
      provider.searchPage(request as never),
      (error: unknown) => providerCode(error, "INVALID_REQUEST"),
    );
  }
  assert.equal(mock.calls.length, 0);
});

test("provider exposes one immutable exact query mapping and rejects all other queries before HTTP", async () => {
  assert.equal(Object.isFrozen(GEOAPIFY_CATEGORY_BY_QUERY), true);
  assert.deepEqual(GEOAPIFY_CATEGORY_BY_QUERY, {
    bakery: "commercial.food_and_drink.bakery",
    bookshop: "commercial.books",
    cafe: "catering.cafe",
    restaurant: "catering.restaurant",
  });

  for (const query of ["Bakery", "independent bookshops", "plumbers"]) {
    const mock = createQueuedFetch([]);
    const provider = createGeoapifyProvider({ provider: "geoapify", apiKey: API_KEY }, { fetch: mock.fetch });
    await assert.rejects(
      provider.searchPage(searchRequest(query) as never),
      (error: unknown) => providerCode(error, "UNSUPPORTED_QUERY"),
    );
    assert.equal(mock.calls.length, 0);
  }
});

test("first page performs exact geocoding then one Places request for every supported query", async () => {
  for (const [query, category] of Object.entries(GEOAPIFY_CATEGORY_BY_QUERY)) {
    const mock = createQueuedFetch([CITY_RESPONSE, collection([])]);
    const provider = createGeoapifyProvider({ provider: "geoapify", apiKey: API_KEY }, { fetch: mock.fetch });
    const page = await provider.searchPage(searchRequest(query, {
      criteria: normalizeDiscoveryCriteria({ location: "Warsaw & injected=false", query, maxResults: 20 }),
      pageSize: query === "bakery" ? 1 : 20,
    }) as never);

    assert.deepEqual(page, { outcomes: [] });
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0]?.url.href.startsWith("https://api.geoapify.com/v1/geocode/search?"), true);
    assert.deepEqual(Object.fromEntries(mock.calls[0]!.url.searchParams), {
      text: "Warsaw & injected=false",
      type: "city",
      format: "json",
      limit: "2",
      lang: "en",
      bias: "countrycode:none",
    });
    assert.equal(mock.calls[0]!.url.searchParams.has("injected"), false);
    assert.equal(mock.calls[1]?.url.href.startsWith("https://api.geoapify.com/v2/places?"), true);
    assert.deepEqual(Object.fromEntries(mock.calls[1]!.url.searchParams), {
      categories: category,
      filter: "place:warsaw-area",
      limit: query === "bakery" ? "1" : "20",
      offset: "0",
      lang: "en",
    });
  }
});

test("full pages advance by raw slots, including rejected slots, and continuation skips geocoding", async () => {
  const firstResults = collection([
    feature({ datasource: identity("n", 1), name: "One" }),
    feature({ datasource: identity("x", 2), name: "Rejected" }),
  ]);
  const mock = createQueuedFetch([
    CITY_RESPONSE,
    firstResults,
    collection([feature({ datasource: identity("w", 3), name: "Three" })]),
  ]);
  const provider = createGeoapifyProvider({ provider: "geoapify", apiKey: API_KEY }, { fetch: mock.fetch });
  const criteria = normalizeDiscoveryCriteria({ location: "Warsaw", query: "cafe", maxResults: 20 });
  const first = await provider.searchPage(searchRequest("cafe", { criteria, pageSize: 2 }) as never);

  assert.equal(first.outcomes.length, 2);
  assert.deepEqual(first.outcomes[1], { status: "rejected", code: "invalid_reference" });
  assert.equal(typeof first.nextCursor, "string");
  const continuation = await provider.searchPage(searchRequest("cafe", {
    criteria,
    pageSize: 1,
    cursor: first.nextCursor,
  }) as never);
  assert.equal(continuation.outcomes.length, 1);
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.calls[2]?.url.pathname, "/v2/places");
  assert.equal(mock.calls[2]?.url.searchParams.get("offset"), "2");
  assert.equal(mock.calls[2]?.url.searchParams.get("limit"), "1");
});

test("short and empty pages have no cursor and never trigger hidden calls", async () => {
  for (const features of [
    [feature({ datasource: identity(), name: "One" })],
    [],
  ]) {
    const mock = createQueuedFetch([CITY_RESPONSE, collection(features)]);
    const provider = createGeoapifyProvider({ provider: "geoapify", apiKey: API_KEY }, { fetch: mock.fetch });
    const page = await provider.searchPage(searchRequest("restaurant", { pageSize: 2 }) as never);
    assert.equal(page.nextCursor, undefined);
    assert.equal(mock.calls.length, 2);
  }
});

test("invalid, mismatched, tampered, and cross-instance cursors make zero HTTP calls", async () => {
  const sourceMock = createQueuedFetch([
    CITY_RESPONSE,
    collection([feature({ datasource: identity(), name: "One" })]),
  ]);
  const source = createGeoapifyProvider({ provider: "geoapify", apiKey: API_KEY }, { fetch: sourceMock.fetch });
  const criteria = normalizeDiscoveryCriteria({ location: "Warsaw", query: "bookshop", maxResults: 20 });
  const first = await source.searchPage(searchRequest("bookshop", { criteria, pageSize: 1 }) as never);
  assert.ok(first.nextCursor);

  const cases = [
    { cursor: "invalid", criteria },
    { cursor: `${first.nextCursor}a`, criteria },
    { cursor: first.nextCursor, criteria: normalizeDiscoveryCriteria({ location: "Krakow", query: "bookshop", maxResults: 20 }) },
  ];
  for (const value of cases) {
    const mock = createQueuedFetch([]);
    const provider = createGeoapifyProvider({ provider: "geoapify", apiKey: API_KEY }, { fetch: mock.fetch });
    await assert.rejects(
      provider.searchPage(searchRequest("bookshop", { ...value, pageSize: 1 }) as never),
      (error: unknown) => providerCode(error, "INVALID_CURSOR"),
    );
    assert.equal(mock.calls.length, 0);
  }
});

test("provider respects pre-cancellation and cancellation before a second request", async () => {
  const preCancelled = new AbortController();
  preCancelled.abort("unsafe reason");
  const noCalls = createQueuedFetch([]);
  const provider = createGeoapifyProvider({ provider: "geoapify", apiKey: API_KEY }, { fetch: noCalls.fetch });
  await assert.rejects(
    provider.searchPage(searchRequest("bakery", { signal: preCancelled.signal }) as never),
    (error: unknown) => providerCode(error, "CANCELLED"),
  );
  assert.equal(noCalls.calls.length, 0);

  const between = new AbortController();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    const body = JSON.stringify(CITY_RESPONSE);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
        queueMicrotask(() => between.abort());
      },
    }), { headers: { "content-type": "application/json" } });
  };
  const cancellable = createGeoapifyProvider({ provider: "geoapify", apiKey: API_KEY }, { fetch: fetchImpl });
  await assert.rejects(
    cancellable.searchPage(searchRequest("bakery", { signal: between.signal }) as never),
    (error: unknown) => providerCode(error, "CANCELLED"),
  );
  assert.equal(calls, 1);
});

test("pagination arithmetic refuses unsafe offsets", () => {
  assert.equal(calculateGeoapifyNextOffset(0, 20), 20);
  assertProviderError(
    () => calculateGeoapifyNextOffset(Number.MAX_SAFE_INTEGER, 1),
    "INVALID_CURSOR",
  );
});
