import {
  normalizeDiscoveryCandidate,
  type DiscoveryCandidateOutcome,
} from "../../domain";
import {
  DiscoveryProviderError,
  MalformedDiscoveryResponseError,
} from "../../errors";
import { MAX_DISCOVERY_PAGE_SIZE } from "../../provider";

const AREA_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const OSM_TYPES = new Set(["n", "w", "r"]);
const MAX_WEBSITE_CHARACTERS = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedEnvelope(): MalformedDiscoveryResponseError {
  return new MalformedDiscoveryResponseError("INVALID_ENVELOPE");
}

export function normalizeGeoapifyGeocodingResponse(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw malformedEnvelope();
  }
  if (value.results.length === 0) {
    throw new DiscoveryProviderError("LOCATION_NOT_FOUND");
  }
  if (value.results.length === 2) {
    throw new DiscoveryProviderError("LOCATION_AMBIGUOUS");
  }
  if (value.results.length > 2) {
    throw malformedEnvelope();
  }
  const result = value.results[0];
  if (!isRecord(result) || typeof result.result_type !== "string") {
    throw malformedEnvelope();
  }
  if (result.result_type !== "city") {
    throw new DiscoveryProviderError("UNSUPPORTED_LOCATION");
  }
  if (typeof result.place_id !== "string" || !AREA_ID_PATTERN.test(result.place_id)) {
    throw malformedEnvelope();
  }
  return result.place_id;
}

function providerReference(properties: Record<string, unknown>): string | undefined {
  const datasource = properties.datasource;
  if (
    !isRecord(datasource) ||
    datasource.sourcename !== "openstreetmap" ||
    !isRecord(datasource.raw)
  ) {
    return undefined;
  }
  const { osm_type: osmType, osm_id: osmId } = datasource.raw;
  if (
    typeof osmType !== "string" ||
    !OSM_TYPES.has(osmType) ||
    typeof osmId !== "number" ||
    !Number.isSafeInteger(osmId) ||
    osmId <= 0
  ) {
    return undefined;
  }
  return `osm:${osmType}:${osmId}`;
}

function normalizeFeature(value: unknown): DiscoveryCandidateOutcome {
  if (!isRecord(value) || value.type !== "Feature" || !isRecord(value.properties)) {
    return Object.freeze({ status: "rejected", code: "invalid_reference" });
  }
  const reference = providerReference(value.properties);
  if (reference === undefined) {
    return Object.freeze({ status: "rejected", code: "invalid_reference" });
  }

  const website = value.properties.website;
  const websiteUrl =
    typeof website === "string" && [...website].length > MAX_WEBSITE_CHARACTERS
      ? ""
      : website;
  return normalizeDiscoveryCandidate({
    provider: "geoapify",
    providerReference: reference,
    businessName: value.properties.name,
    websiteUrl,
  });
}

export function normalizeGeoapifyPlacesResponse(
  value: unknown,
  pageSize: number,
): readonly DiscoveryCandidateOutcome[] {
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_DISCOVERY_PAGE_SIZE ||
    !isRecord(value) ||
    value.type !== "FeatureCollection" ||
    !Array.isArray(value.features) ||
    value.features.length > pageSize
  ) {
    throw malformedEnvelope();
  }
  return Object.freeze(value.features.map(normalizeFeature));
}
