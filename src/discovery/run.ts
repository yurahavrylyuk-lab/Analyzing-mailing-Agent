import { normalizeAuditActor, type AuditActor } from "../audit";
import {
  InvalidDiscoveredLeadInputError,
  LeadPersistenceError,
  type RecordDiscoveredLeadInput,
  type RecordDiscoveredLeadResult,
} from "../leads";
import {
  normalizeDiscoveryCriteria,
  normalizeDiscoveryProviderId,
  type DiscoveryCriteriaInput,
} from "./domain";
import { DiscoveryProviderError, type DiscoveryProviderErrorCode } from "./errors";
import {
  MAX_DISCOVERY_PAGE_SIZE,
  normalizeDiscoveryPage,
  type DiscoveryProvider,
} from "./provider";

export type DiscoveryLeadRecorder = Readonly<{
  recordDiscoveredLead(
    input: RecordDiscoveredLeadInput,
    actor: AuditActor,
  ): RecordDiscoveredLeadResult;
}>;

export type DiscoveryRunRequest = Readonly<{
  criteria: DiscoveryCriteriaInput;
  provider: DiscoveryProvider;
  leads: DiscoveryLeadRecorder;
  actor: AuditActor;
  signal: AbortSignal;
}>;

export type DiscoveryRunSummary = Readonly<{
  /** Normalized outcomes from pages that passed page validation. Drives maxResults. */
  slotsExamined: number;
  /** Accepted outcomes included in slotsExamined. */
  slotsAccepted: number;
  /** Rejected outcomes included in slotsExamined. */
  slotsRejected: number;
  /** Accepted outcomes whose recordDiscoveredLead call returned. */
  acceptedPersisted: number;
  /** acceptedPersisted outcomes with created: true. */
  leadsCreated: number;
  /** acceptedPersisted outcomes with created: false. */
  leadsDuplicate: number;
  /** Provider pages that returned and passed page-level validation. */
  pagesFetched: number;
}>;

export type DiscoveryPaginationBlockCode =
  | "REPEATED_CURSOR"
  | "EMPTY_PAGE_WITH_CURSOR"
  | "PAGE_ITERATION_CAP";

export type DiscoveryRunStop =
  | Readonly<{
      status: "completed";
      reason: "budget_exhausted" | "results_exhausted";
    }>
  | Readonly<{ status: "cancelled"; reason: "cancelled" }>
  | Readonly<{
      status: "failed";
      reason: "provider_error";
      code: DiscoveryProviderErrorCode | "UNEXPECTED";
    }>
  | Readonly<{
      status: "failed";
      reason: "malformed_page";
      code: "MALFORMED_PAGE";
    }>
  | Readonly<{
      status: "failed";
      reason: "pagination_blocked";
      code: DiscoveryPaginationBlockCode;
    }>
  | Readonly<{
      status: "failed";
      reason: "persistence_error";
      code: "PERSISTENCE_FAILED" | "INVALID_DISCOVERED_LEAD" | "UNEXPECTED";
    }>;

export type DiscoveryRunResult = Readonly<{
  providerId: string;
  summary: DiscoveryRunSummary;
  stop: DiscoveryRunStop;
}>;

type MutableSummary = {
  slotsExamined: number;
  slotsAccepted: number;
  slotsRejected: number;
  acceptedPersisted: number;
  leadsCreated: number;
  leadsDuplicate: number;
  pagesFetched: number;
};

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function cancelledStop(): DiscoveryRunStop {
  return Object.freeze({ status: "cancelled", reason: "cancelled" });
}

function providerFailureStop(error: unknown): DiscoveryRunStop {
  if (error instanceof DiscoveryProviderError) {
    if (error.code === "CANCELLED") {
      return cancelledStop();
    }
    return Object.freeze({
      status: "failed",
      reason: "provider_error",
      code: error.code,
    });
  }
  return Object.freeze({
    status: "failed",
    reason: "provider_error",
    code: "UNEXPECTED",
  });
}

function persistenceFailureStop(error: unknown): DiscoveryRunStop {
  if (error instanceof LeadPersistenceError) {
    return Object.freeze({
      status: "failed",
      reason: "persistence_error",
      code: "PERSISTENCE_FAILED",
    });
  }
  if (error instanceof InvalidDiscoveredLeadInputError) {
    return Object.freeze({
      status: "failed",
      reason: "persistence_error",
      code: "INVALID_DISCOVERED_LEAD",
    });
  }
  return Object.freeze({
    status: "failed",
    reason: "persistence_error",
    code: "UNEXPECTED",
  });
}

function finish(
  providerId: string,
  summary: MutableSummary,
  stop: DiscoveryRunStop,
): DiscoveryRunResult {
  return Object.freeze({
    providerId,
    summary: Object.freeze({ ...summary }),
    stop,
  });
}

export async function runBoundedDiscovery(
  request: DiscoveryRunRequest,
): Promise<DiscoveryRunResult> {
  const criteria = normalizeDiscoveryCriteria(request.criteria);
  const actor = normalizeAuditActor(request.actor);
  if (!(request.signal instanceof AbortSignal)) {
    throw new DiscoveryProviderError("INVALID_REQUEST");
  }
  if (
    !isObject(request.provider) ||
    typeof request.provider.searchPage !== "function" ||
    !isObject(request.leads) ||
    typeof request.leads.recordDiscoveredLead !== "function"
  ) {
    throw new DiscoveryProviderError("INVALID_REQUEST");
  }

  const provider = request.provider;
  const leads = request.leads;
  const providerId = normalizeDiscoveryProviderId(provider.id);
  const signal = request.signal;
  let remaining = criteria.maxResults;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const followedCursors = new Set<string>();
  let searchAttempts = 0;
  const summary: MutableSummary = {
    slotsExamined: 0,
    slotsAccepted: 0,
    slotsRejected: 0,
    acceptedPersisted: 0,
    leadsCreated: 0,
    leadsDuplicate: 0,
    pagesFetched: 0,
  };

  for (;;) {
    if (signal.aborted) {
      return finish(providerId, summary, cancelledStop());
    }
    if (searchAttempts >= criteria.maxResults) {
      return finish(
        providerId,
        summary,
        Object.freeze({
          status: "failed",
          reason: "pagination_blocked",
          code: "PAGE_ITERATION_CAP",
        }),
      );
    }
    if (cursor !== undefined && followedCursors.has(cursor)) {
      return finish(
        providerId,
        summary,
        Object.freeze({
          status: "failed",
          reason: "pagination_blocked",
          code: "REPEATED_CURSOR",
        }),
      );
    }

    const pageSize = Math.min(MAX_DISCOVERY_PAGE_SIZE, remaining);
    searchAttempts += 1;
    const pageRequest =
      cursor === undefined
        ? { criteria, pageSize, signal }
        : { criteria, pageSize, cursor, signal };
    if (cursor !== undefined) {
      followedCursors.add(cursor);
    }

    let raw: unknown;
    try {
      raw = await provider.searchPage(pageRequest);
    } catch (error) {
      return finish(providerId, summary, providerFailureStop(error));
    }

    let page;
    try {
      page = normalizeDiscoveryPage(raw, pageSize, providerId);
    } catch {
      return finish(
        providerId,
        summary,
        Object.freeze({
          status: "failed",
          reason: "malformed_page",
          code: "MALFORMED_PAGE",
        }),
      );
    }

    let acceptedOnPage = 0;
    let rejectedOnPage = 0;
    for (const outcome of page.outcomes) {
      if (outcome.status === "accepted") {
        acceptedOnPage += 1;
      } else {
        rejectedOnPage += 1;
      }
    }
    const outcomeCount = page.outcomes.length;
    summary.slotsExamined += outcomeCount;
    summary.slotsAccepted += acceptedOnPage;
    summary.slotsRejected += rejectedOnPage;
    remaining -= outcomeCount;
    summary.pagesFetched += 1;

    if (outcomeCount === 0 && page.nextCursor !== undefined) {
      return finish(
        providerId,
        summary,
        Object.freeze({
          status: "failed",
          reason: "pagination_blocked",
          code: "EMPTY_PAGE_WITH_CURSOR",
        }),
      );
    }

    for (const outcome of page.outcomes) {
      if (signal.aborted) {
        return finish(providerId, summary, cancelledStop());
      }
      if (outcome.status !== "accepted") {
        continue;
      }
      try {
        const recorded = leads.recordDiscoveredLead(
          {
            provider: outcome.candidate.provider,
            providerReference: outcome.candidate.providerReference,
            businessName: outcome.candidate.businessName,
            websiteObservation: outcome.candidate.websiteObservation,
          },
          actor,
        );
        summary.acceptedPersisted += 1;
        if (recorded.created) {
          summary.leadsCreated += 1;
        } else {
          summary.leadsDuplicate += 1;
        }
      } catch (error) {
        return finish(providerId, summary, persistenceFailureStop(error));
      }
    }

    if (page.nextCursor === undefined) {
      return finish(
        providerId,
        summary,
        Object.freeze({ status: "completed", reason: "results_exhausted" }),
      );
    }
    if (remaining === 0) {
      return finish(
        providerId,
        summary,
        Object.freeze({ status: "completed", reason: "budget_exhausted" }),
      );
    }
    if (seenCursors.has(page.nextCursor) || followedCursors.has(page.nextCursor)) {
      return finish(
        providerId,
        summary,
        Object.freeze({
          status: "failed",
          reason: "pagination_blocked",
          code: "REPEATED_CURSOR",
        }),
      );
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
