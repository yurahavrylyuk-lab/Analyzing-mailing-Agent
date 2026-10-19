import { randomBytes } from "node:crypto";

import type { DiscoveryConfig } from "../../../config/env";
import { normalizeDiscoveryCriteria, type DiscoveryCriteria } from "../../domain";
import { DiscoveryProviderError } from "../../errors";
import {
  normalizeDiscoveryPage,
  validateDiscoveryPageSize,
  type DiscoveryPageRequest,
  type DiscoveryProvider,
} from "../../provider";
import { createGeoapifyCursorCodec } from "./cursor";
import { requestGeoapifyJson } from "./http";
import {
  normalizeGeoapifyGeocodingResponse,
  normalizeGeoapifyPlacesResponse,
} from "./normalization";

export const GEOAPIFY_CATEGORY_BY_QUERY = Object.freeze({
  bakery: "commercial.food_and_drink.bakery",
  bookshop: "commercial.books",
  cafe: "catering.cafe",
  restaurant: "catering.restaurant",
} as const);

type SupportedGeoapifyQuery = keyof typeof GEOAPIFY_CATEGORY_BY_QUERY;
type GeoapifyConfig = Extract<DiscoveryConfig, { provider: "geoapify" }>;
export type GeoapifyProviderOptions = Readonly<{ fetch?: typeof fetch }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function invalidRequest(): DiscoveryProviderError {
  return new DiscoveryProviderError("INVALID_REQUEST");
}

function normalizeRequest(input: unknown): Readonly<{
  criteria: DiscoveryCriteria;
  pageSize: number;
  cursor?: unknown;
  signal: AbortSignal;
}> {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["criteria", "pageSize", "cursor", "signal"]) ||
    !("criteria" in input) ||
    !("pageSize" in input) ||
    !("signal" in input) ||
    !(input.signal instanceof AbortSignal)
  ) {
    throw invalidRequest();
  }
  let criteria: DiscoveryCriteria;
  let pageSize: number;
  try {
    criteria = normalizeDiscoveryCriteria(input.criteria);
    pageSize = validateDiscoveryPageSize(input.pageSize);
  } catch {
    throw invalidRequest();
  }
  return {
    criteria,
    pageSize,
    signal: input.signal,
    ...(Object.hasOwn(input, "cursor") ? { cursor: input.cursor } : {}),
  };
}

function supportedCategory(query: string): string {
  if (!Object.hasOwn(GEOAPIFY_CATEGORY_BY_QUERY, query)) {
    throw new DiscoveryProviderError("UNSUPPORTED_QUERY");
  }
  return GEOAPIFY_CATEGORY_BY_QUERY[query as SupportedGeoapifyQuery];
}

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DiscoveryProviderError("CANCELLED");
  }
}

export function calculateGeoapifyNextOffset(offset: number, rawSlotCount: number): number {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(rawSlotCount) ||
    rawSlotCount < 0 ||
    !Number.isSafeInteger(offset + rawSlotCount)
  ) {
    throw new DiscoveryProviderError("INVALID_CURSOR");
  }
  return offset + rawSlotCount;
}

function geocodingParameters(location: string): URLSearchParams {
  return new URLSearchParams([
    ["text", location],
    ["type", "city"],
    ["format", "json"],
    ["limit", "2"],
    ["lang", "en"],
    ["bias", "countrycode:none"],
  ]);
}

function placesParameters(
  category: string,
  areaId: string,
  pageSize: number,
  offset: number,
): URLSearchParams {
  return new URLSearchParams([
    ["categories", category],
    ["filter", `place:${areaId}`],
    ["limit", String(pageSize)],
    ["offset", String(offset)],
    ["lang", "en"],
  ]);
}

export function createGeoapifyProvider(
  config: GeoapifyConfig,
  options: GeoapifyProviderOptions = {},
): DiscoveryProvider {
  if (
    !isRecord(config) ||
    !hasOnlyKeys(config, ["provider", "apiKey"]) ||
    config.provider !== "geoapify" ||
    typeof config.apiKey !== "string" ||
    config.apiKey.length === 0 ||
    /[\s\u0000-\u001f\u007f-\u009f]/u.test(config.apiKey)
  ) {
    throw new TypeError("Geoapify provider configuration is invalid.");
  }
  const apiKey = config.apiKey;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const cursorCodec = createGeoapifyCursorCodec(randomBytes(32));

  const provider: DiscoveryProvider = {
    id: "geoapify",
    async searchPage(requestInput: DiscoveryPageRequest) {
      const request = normalizeRequest(requestInput);
      const category = supportedCategory(request.criteria.query);

      let areaId: string;
      let offset: number;
      if (request.cursor === undefined) {
        checkCancellation(request.signal);
        const geocoding = await requestGeoapifyJson(
          "geocode",
          geocodingParameters(request.criteria.location),
          apiKey,
          request.signal,
          { fetchImpl },
        );
        areaId = normalizeGeoapifyGeocodingResponse(geocoding);
        offset = 0;
      } else {
        const decoded = cursorCodec.decode(request.cursor as string, request.criteria);
        areaId = decoded.areaId;
        offset = decoded.offset;
      }

      checkCancellation(request.signal);
      const places = await requestGeoapifyJson(
        "places",
        placesParameters(category, areaId, request.pageSize, offset),
        apiKey,
        request.signal,
        { fetchImpl },
      );
      const outcomes = normalizeGeoapifyPlacesResponse(places, request.pageSize);
      const nextOffset = calculateGeoapifyNextOffset(offset, outcomes.length);
      const nextCursor =
        outcomes.length === request.pageSize
          ? cursorCodec.encode(areaId, nextOffset, request.criteria)
          : undefined;
      return normalizeDiscoveryPage(
        { outcomes, ...(nextCursor === undefined ? {} : { nextCursor }) },
        request.pageSize,
        "geoapify",
      );
    },
  };
  return Object.freeze(provider);
}
