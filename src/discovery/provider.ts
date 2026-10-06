import {
  normalizeDiscoveryOutcome,
  normalizeDiscoveryProviderId,
  type DiscoveryCandidateOutcome,
  type DiscoveryCriteria,
} from "./domain";
import { MalformedDiscoveryResponseError } from "./errors";

export const MAX_DISCOVERY_PAGE_SIZE = 20;
export const MAX_DISCOVERY_CURSOR_CHARACTERS = 8192;

export type DiscoveryPage = Readonly<{
  /** Ordered one-for-one outcomes for the provider result slots returned. */
  outcomes: readonly DiscoveryCandidateOutcome[];
  nextCursor?: string;
}>;

export type DiscoveryPageRequest = Readonly<{
  criteria: DiscoveryCriteria;
  pageSize: number;
  cursor?: string;
  signal: AbortSignal;
}>;

export interface DiscoveryProvider {
  readonly id: string;
  searchPage(request: DiscoveryPageRequest): Promise<DiscoveryPage>;
}

const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function validateDiscoveryPageSize(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 1 ||
    input > MAX_DISCOVERY_PAGE_SIZE
  ) {
    throw new MalformedDiscoveryResponseError();
  }
  return input;
}

export function normalizeDiscoveryCursor(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    controlCharacterPattern.test(input) ||
    [...input].length > MAX_DISCOVERY_CURSOR_CHARACTERS
  ) {
    throw new MalformedDiscoveryResponseError();
  }
  return input;
}

export function normalizeDiscoveryPage(
  input: unknown,
  requestedPageSizeInput: unknown,
  expectedProviderInput: unknown,
): DiscoveryPage {
  const requestedPageSize = validateDiscoveryPageSize(requestedPageSizeInput);
  const expectedProvider = normalizeDiscoveryProviderId(expectedProviderInput);
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["outcomes", "nextCursor"]) ||
    !Array.isArray(input.outcomes) ||
    input.outcomes.length > requestedPageSize
  ) {
    throw new MalformedDiscoveryResponseError();
  }

  const outcomes = input.outcomes.map((outcome) =>
    normalizeDiscoveryOutcome(outcome, expectedProvider),
  );
  const nextCursor = normalizeDiscoveryCursor(input.nextCursor);
  return Object.freeze({
    outcomes: Object.freeze(outcomes),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}
