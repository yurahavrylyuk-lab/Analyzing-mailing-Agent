import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

import {
  DatabaseAuditRepository,
  InvalidAuditActorError,
  auditMigrations,
  type AuditActor,
} from "../../src/audit";
import { DoNotContactService, complianceMigrations } from "../../src/compliance";
import { applyMigrations, createDatabase, type Database } from "../../src/db";
import {
  DiscoveryProviderError,
  InvalidDiscoveryCriteriaError,
  runBoundedDiscovery,
  type DiscoveryCandidateOutcome,
  type DiscoveryCandidateWarningCode,
  type DiscoveryLeadRecorder,
  type DiscoveryPage,
  type DiscoveryPageRequest,
  type DiscoveryProvider,
  type DiscoveryRunResult,
} from "../../src/discovery";
import { FakeDiscoveryProvider } from "../helpers/fake-discovery-provider";
import {
  DatabaseLeadRepository,
  InvalidDiscoveredLeadInputError,
  LeadService,
  leadMigrations,
  type RecordDiscoveredLeadInput,
} from "../../src/leads";

const providerId = "approved_directory";
const location = "Qoralis-Harbor";
const query = "marker-query";
const actor: AuditActor = { type: "system", id: "dq-014-runner" };

function idSequence(): () => string {
  let next = 1;
  return () => {
    const suffix = next.toString(16).padStart(12, "0");
    next += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  };
}

function openDatabase(): Database {
  const database = createDatabase({ url: "file::memory:" });
  applyMigrations(database, [...leadMigrations, ...auditMigrations, ...complianceMigrations]);
  return database;
}

function createLeads(database: Database, ids: () => string = idSequence()): LeadService {
  return new LeadService(database, {
    idGenerator: ids,
    clock: () => new Date("2026-05-01T00:00:00.000Z"),
  });
}

function accepted(
  reference: string,
  options: {
    businessName?: string;
    websiteObservation?: RecordDiscoveredLeadInput["websiteObservation"];
    warnings?: readonly DiscoveryCandidateWarningCode[];
  } = {},
): DiscoveryCandidateOutcome {
  return {
    status: "accepted",
    candidate: {
      provider: providerId,
      providerReference: reference,
      businessName: options.businessName ?? `Business ${reference}`,
      websiteObservation: options.websiteObservation ?? { presence: "unknown" },
    },
    warnings: options.warnings ?? [],
  };
}

function rejected(
  code: "invalid_reference" | "invalid_business_name" = "invalid_reference",
): DiscoveryCandidateOutcome {
  return { status: "rejected", code };
}

function page(
  outcomes: readonly DiscoveryCandidateOutcome[],
  nextCursor?: string,
): DiscoveryPage {
  return nextCursor === undefined ? { outcomes } : { outcomes, nextCursor };
}

function countRows(database: Database, table: "business_leads" | "audit_events" | "lead_contact_suppressions"): number {
  return database.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count ?? 0;
}

function discovered(database: Database, reference: string) {
  return new DatabaseLeadRepository(database).findByDiscoveryIdentity(providerId, reference);
}

function audits(database: Database, leadId: string) {
  return new DatabaseAuditRepository(database).listForEntity("business_lead", leadId).map((event) => ({
    eventType: event.eventType,
    actor: event.actor,
    details: event.details,
  }));
}

function assertRunInvariants(
  result: DiscoveryRunResult,
  maxResults: number,
  forbidden: readonly string[] = [],
): void {
  const { summary } = result;
  assert.equal(summary.slotsExamined, summary.slotsAccepted + summary.slotsRejected);
  assert.equal(summary.acceptedPersisted, summary.leadsCreated + summary.leadsDuplicate);
  assert.ok(summary.acceptedPersisted <= summary.slotsAccepted);
  assert.ok(summary.slotsExamined <= maxResults);
  assert.ok(summary.pagesFetched <= maxResults);
  for (const value of [
    summary.slotsExamined,
    summary.slotsAccepted,
    summary.slotsRejected,
    summary.acceptedPersisted,
    summary.leadsCreated,
    summary.leadsDuplicate,
    summary.pagesFetched,
  ]) {
    assert.equal(Number.isInteger(value), true);
    assert.ok(value >= 0);
  }
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(result.stop), true);
  assert.deepEqual(Object.keys(result).sort(), ["providerId", "stop", "summary"]);
  assert.deepEqual(Object.keys(summary).sort(), [
    "acceptedPersisted",
    "leadsCreated",
    "leadsDuplicate",
    "pagesFetched",
    "slotsAccepted",
    "slotsExamined",
    "slotsRejected",
  ]);
  const encoded = JSON.stringify(result);
  for (const secret of [location, query, ...forbidden]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  assert.equal(result.providerId, providerId);
}

class ScriptedDiscoveryProvider implements DiscoveryProvider {
  readonly requests: DiscoveryPageRequest[] = [];
  private next = 0;

  constructor(
    readonly id: string,
    private readonly steps: readonly ((request: DiscoveryPageRequest) => DiscoveryPage | Promise<DiscoveryPage>)[],
  ) {}

  async searchPage(request: DiscoveryPageRequest): Promise<DiscoveryPage> {
    this.requests.push(request);
    const step = this.steps[this.next];
    this.next += 1;
    if (step === undefined) {
      throw new Error("scripted discovery sequence exhausted");
    }
    return step(request);
  }
}

test("single page under the default budget omits the cursor and exhausts results", async () => {
  const database = openDatabase();
  const provider = new FakeDiscoveryProvider(providerId, [
    page([
      accepted("fresh-ref", {
        businessName: "Fresh Bakery",
        websiteObservation: { presence: "present", url: "https://fresh.example/" },
      }),
      accepted("warned-ref", {
        businessName: "Warned Bakery",
        warnings: ["invalid_website"],
      }),
      rejected("invalid_business_name"),
    ]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query },
      provider,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 20);
    assert.deepEqual(result.stop, { status: "completed", reason: "results_exhausted" });
    assert.equal(result.summary.pagesFetched, 1);
    assert.equal(result.summary.slotsExamined, 3);
    assert.equal(result.summary.slotsAccepted, 2);
    assert.equal(result.summary.slotsRejected, 1);
    assert.equal(result.summary.leadsCreated, 2);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]?.pageSize, 20);
    assert.equal(Object.hasOwn(provider.requests[0] ?? {}, "cursor"), false);
    assert.equal(discovered(database, "warned-ref")?.websiteObservation.presence, "unknown");
    assert.equal(countRows(database, "business_leads"), 2);
  } finally {
    database.close();
  }
});

test("multi-page run keeps one provider, the original criteria, and shrinking page sizes", async () => {
  const database = openDatabase();
  const first = Array.from({ length: 20 }, (_, index) => accepted(`page-one-${index}`));
  const second = Array.from({ length: 5 }, (_, index) => accepted(`page-two-${index}`));
  const provider = new FakeDiscoveryProvider(providerId, [
    page(first, "cursor-page-1"),
    page(second),
    page([accepted("must-not-fetch")]),
  ]);
  const unused = new FakeDiscoveryProvider(providerId, [page([accepted("unused-ref")])]);
  const signal = new AbortController().signal;
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 25 },
      provider,
      leads: createLeads(database),
      actor,
      signal,
    });
    assertRunInvariants(result, 25, ["cursor-page-1"]);
    assert.deepEqual(result.stop, { status: "completed", reason: "results_exhausted" });
    assert.equal(result.summary.pagesFetched, 2);
    assert.equal(result.summary.slotsExamined, 25);
    assert.equal(result.summary.leadsCreated, 25);
    assert.equal(provider.requests.length, 2);
    assert.equal(unused.requests.length, 0);
    assert.equal(provider.requests[0]?.pageSize, 20);
    assert.equal(provider.requests[1]?.pageSize, 5);
    assert.equal(provider.requests[0]?.criteria, provider.requests[1]?.criteria);
    assert.equal(provider.requests[0]?.criteria.maxResults, 25);
    assert.equal(provider.requests[0]?.signal, signal);
    assert.equal(provider.requests[1]?.signal, signal);
    assert.equal(Object.hasOwn(provider.requests[0] ?? {}, "cursor"), false);
    assert.equal(provider.requests[1]?.cursor, "cursor-page-1");
    assert.equal(countRows(database, "business_leads"), 25);
  } finally {
    database.close();
  }
});

test("budget truncation examines the requested page and does not follow the next cursor", async () => {
  const database = openDatabase();
  const provider = new FakeDiscoveryProvider(providerId, [
    page(Array.from({ length: 5 }, (_, index) => accepted(`budget-${index}`)), "cursor-more"),
    page([accepted("beyond-budget")]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 5 },
      provider,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 5, ["cursor-more"]);
    assert.deepEqual(result.stop, { status: "completed", reason: "budget_exhausted" });
    assert.equal(result.summary.pagesFetched, 1);
    assert.equal(result.summary.slotsExamined, 5);
    assert.equal(result.summary.leadsCreated, 5);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]?.pageSize, 5);
    assert.equal(discovered(database, "beyond-budget"), undefined);
  } finally {
    database.close();
  }
});

test("rejected outcomes consume slots and are not persisted", async () => {
  const database = openDatabase();
  const provider = new FakeDiscoveryProvider(providerId, [
    page([rejected(), rejected("invalid_business_name"), rejected()]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 10 },
      provider,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 10);
    assert.deepEqual(result.stop, { status: "completed", reason: "results_exhausted" });
    assert.equal(result.summary.slotsExamined, 3);
    assert.equal(result.summary.slotsRejected, 3);
    assert.equal(result.summary.slotsAccepted, 0);
    assert.equal(result.summary.acceptedPersisted, 0);
    assert.equal(result.summary.leadsCreated, 0);
    assert.equal(result.summary.leadsDuplicate, 0);
    assert.equal(countRows(database, "business_leads"), 0);
    assert.equal(countRows(database, "audit_events"), 0);
  } finally {
    database.close();
  }
});

test("a new accepted outcome creates one recorded lead and one lead.created event", async () => {
  const database = openDatabase();
  const provider = new FakeDiscoveryProvider(providerId, [
    page([
      accepted("new-ref", {
        businessName: "New Harbor Bakery",
        websiteObservation: { presence: "present", url: "https://new.example/" },
      }),
    ]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 5 },
      provider,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 5);
    assert.equal(result.summary.leadsCreated, 1);
    assert.equal(result.summary.acceptedPersisted, 1);
    const lead = discovered(database, "new-ref");
    assert.equal(lead?.status, "recorded");
    assert.equal(lead?.businessName, "New Harbor Bakery");
    assert.deepEqual(lead?.websiteObservation, {
      presence: "present",
      url: "https://new.example/",
    });
    assert.deepEqual(audits(database, lead?.id ?? ""), [{
      eventType: "lead.created",
      actor,
      details: { initialStatus: "recorded", initialWebsitePresence: "present", version: 1 },
    }]);
  } finally {
    database.close();
  }
});

test("a duplicate consumes a slot, returns the stored lead, and adds no audit event", async () => {
  const database = openDatabase();
  const leads = createLeads(database);
  const seeded = leads.recordDiscoveredLead({
    provider: providerId,
    providerReference: "dup-ref",
    businessName: "Stored Bakery",
    websiteObservation: { presence: "present", url: "https://stored.example/" },
  }, actor);
  const before = audits(database, seeded.lead.id);
  const provider = new FakeDiscoveryProvider(providerId, [
    page([
      accepted("dup-ref", {
        businessName: "Changed Name",
        websiteObservation: { presence: "unknown" },
      }),
    ]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 4 },
      provider,
      leads,
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 4);
    assert.equal(result.summary.slotsExamined, 1);
    assert.equal(result.summary.slotsAccepted, 1);
    assert.equal(result.summary.acceptedPersisted, 1);
    assert.equal(result.summary.leadsCreated, 0);
    assert.equal(result.summary.leadsDuplicate, 1);
    assert.equal(discovered(database, "dup-ref")?.businessName, "Stored Bakery");
    assert.deepEqual(discovered(database, "dup-ref")?.websiteObservation, seeded.lead.websiteObservation);
    assert.deepEqual(audits(database, seeded.lead.id), before);
    assert.equal(countRows(database, "business_leads"), 1);
  } finally {
    database.close();
  }
});

test("summary counts separate examined slots from persisted accepts and duplicates", async () => {
  const database = openDatabase();
  const leads = createLeads(database);
  leads.recordDiscoveredLead({
    provider: providerId,
    providerReference: "dup-ref",
    businessName: "Stored Bakery",
    websiteObservation: { presence: "unknown" },
  }, actor);
  const provider = new FakeDiscoveryProvider(providerId, [
    page([
      accepted("new-ref"),
      rejected(),
      accepted("dup-ref", { businessName: "Ignored" }),
    ]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 9 },
      provider,
      leads,
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 9);
    assert.equal(result.summary.slotsExamined, 3);
    assert.equal(result.summary.slotsAccepted, 2);
    assert.equal(result.summary.slotsRejected, 1);
    assert.equal(result.summary.acceptedPersisted, 2);
    assert.equal(result.summary.leadsCreated, 1);
    assert.equal(result.summary.leadsDuplicate, 1);
    assert.equal(result.summary.pagesFetched, 1);
    assert.deepEqual(result.stop, { status: "completed", reason: "results_exhausted" });
  } finally {
    database.close();
  }
});

test("a short page with budget remaining and no cursor is results_exhausted", async () => {
  const database = openDatabase();
  const provider = new FakeDiscoveryProvider(providerId, [
    page([accepted("only-ref")]),
    page([accepted("not-requested")]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 8 },
      provider,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 8);
    assert.deepEqual(result.stop, { status: "completed", reason: "results_exhausted" });
    assert.equal(provider.requests.length, 1);
    assert.equal(result.summary.pagesFetched, 1);
    assert.equal(result.summary.slotsExamined, 1);
    assert.ok(result.summary.slotsExamined < 8);
  } finally {
    database.close();
  }
});

test("a stationary repeated cursor stops after the repeated page is persisted", async () => {
  const database = openDatabase();
  const provider = new FakeDiscoveryProvider(providerId, [
    page([accepted("first-ref")], "cursor-a"),
    page([accepted("second-ref")], "cursor-a"),
    page([accepted("third-ref")], "cursor-c"),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 10 },
      provider,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 10, ["cursor-a", "cursor-c"]);
    assert.deepEqual(result.stop, {
      status: "failed",
      reason: "pagination_blocked",
      code: "REPEATED_CURSOR",
    });
    assert.equal(provider.requests.length, 2);
    assert.equal(Object.hasOwn(provider.requests[0] ?? {}, "cursor"), false);
    assert.equal(provider.requests[1]?.cursor, "cursor-a");
    assert.equal(result.summary.pagesFetched, 2);
    assert.equal(result.summary.slotsExamined, 2);
    assert.equal(result.summary.leadsCreated, 2);
    assert.equal(discovered(database, "third-ref"), undefined);
  } finally {
    database.close();
  }
});

test("cursor cycle A to B to A persists three pages and does not send the repeated cursor", async () => {
  const database = openDatabase();
  const provider = new FakeDiscoveryProvider(providerId, [
    page([accepted("cycle-a")], "cursor-a"),
    page([accepted("cycle-b")], "cursor-b"),
    page([accepted("cycle-a-again")], "cursor-a"),
    page([accepted("cycle-fourth")]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 12 },
      provider,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 12, ["cursor-a", "cursor-b"]);
    assert.deepEqual(result.stop, {
      status: "failed",
      reason: "pagination_blocked",
      code: "REPEATED_CURSOR",
    });
    assert.equal(provider.requests.length, 3);
    assert.equal(Object.hasOwn(provider.requests[0] ?? {}, "cursor"), false);
    assert.equal(provider.requests[1]?.cursor, "cursor-a");
    assert.equal(provider.requests[2]?.cursor, "cursor-b");
    assert.equal(result.summary.pagesFetched, 3);
    assert.equal(result.summary.slotsExamined, 3);
    assert.equal(result.summary.acceptedPersisted, 3);
    assert.equal(result.summary.leadsCreated, 3);
    assert.notEqual(discovered(database, "cycle-a-again"), undefined);
    assert.equal(discovered(database, "cycle-fourth"), undefined);
  } finally {
    database.close();
  }
});

test("an empty page with a cursor is pagination blocked and adds no leads", async () => {
  const database = openDatabase();
  const provider = new FakeDiscoveryProvider(providerId, [
    page([], "cursor-empty"),
    page([accepted("should-not")]),
  ]);
  try {
    const first = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 6 },
      provider,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(first, 6, ["cursor-empty"]);
    assert.deepEqual(first.stop, {
      status: "failed",
      reason: "pagination_blocked",
      code: "EMPTY_PAGE_WITH_CURSOR",
    });
    assert.equal(first.summary.pagesFetched, 1);
    assert.equal(first.summary.slotsExamined, 0);
    assert.equal(provider.requests.length, 1);
    assert.equal(countRows(database, "business_leads"), 0);

    const repeating = new FakeDiscoveryProvider(providerId, [
      page([accepted("kept-ref")], "cursor-a"),
      page([], "cursor-a"),
      page([accepted("after-empty")]),
    ]);
    const second = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 6 },
      provider: repeating,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(second, 6, ["cursor-a"]);
    assert.deepEqual(second.stop, {
      status: "failed",
      reason: "pagination_blocked",
      code: "EMPTY_PAGE_WITH_CURSOR",
    });
    assert.equal(second.summary.pagesFetched, 2);
    assert.equal(second.summary.slotsExamined, 1);
    assert.equal(second.summary.leadsCreated, 1);
    assert.equal(repeating.requests.length, 2);
    assert.equal(discovered(database, "after-empty"), undefined);
  } finally {
    database.close();
  }
});

test("an over-returned page persists nothing from that response", async () => {
  const database = openDatabase();
  const overflow = Array.from({ length: 11 }, (_, index) => accepted(`overflow-${index}`));
  const provider = new ScriptedDiscoveryProvider(providerId, [
    () => page([accepted("kept-ref")], "cursor-next"),
    () => page(overflow, "cursor-after-overflow"),
    () => page([accepted("after-malformed")]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 10 },
      provider,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 10, ["cursor-next", "cursor-after-overflow", "overflow-0"]);
    assert.deepEqual(result.stop, {
      status: "failed",
      reason: "malformed_page",
      code: "MALFORMED_PAGE",
    });
    assert.equal(result.summary.pagesFetched, 1);
    assert.equal(result.summary.slotsExamined, 1);
    assert.equal(result.summary.leadsCreated, 1);
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[1]?.pageSize, 9);
    assert.notEqual(discovered(database, "kept-ref"), undefined);
    assert.equal(discovered(database, "overflow-0"), undefined);
    assert.equal(discovered(database, "overflow-10"), undefined);
    assert.equal(countRows(database, "business_leads"), 1);
  } finally {
    database.close();
  }
});

test("provider failure after progress keeps the committed page and hides provider text", async () => {
  const database = openDatabase();
  const ids = idSequence();
  try {
    const limited = new ScriptedDiscoveryProvider(providerId, [
      () => page([accepted("kept-ref")], "cursor-next"),
      () => {
        throw new DiscoveryProviderError("RATE_LIMITED");
      },
    ]);
    const limitedResult = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 8 },
      provider: limited,
      leads: createLeads(database, ids),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(limitedResult, 8, ["cursor-next"]);
    assert.deepEqual(limitedResult.stop, {
      status: "failed",
      reason: "provider_error",
      code: "RATE_LIMITED",
    });
    assert.equal(limitedResult.summary.pagesFetched, 1);
    assert.equal(limitedResult.summary.slotsExamined, 1);
    assert.equal(limitedResult.summary.leadsCreated, 1);
    assert.equal(limited.requests.length, 2);
    assert.notEqual(discovered(database, "kept-ref"), undefined);

    const secret = new ScriptedDiscoveryProvider(providerId, [
      () => page([accepted("secret-page-ref")], "cursor-secret"),
      () => {
        throw new Error("sentinel-secret");
      },
    ]);
    const secretResult = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 8 },
      provider: secret,
      leads: createLeads(database, ids),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(secretResult, 8, ["sentinel-secret", "cursor-secret"]);
    assert.deepEqual(secretResult.stop, {
      status: "failed",
      reason: "provider_error",
      code: "UNEXPECTED",
    });
    assert.equal(secretResult.summary.pagesFetched, 1);
    assert.equal(secretResult.summary.slotsExamined, 1);
    assert.notEqual(discovered(database, "secret-page-ref"), undefined);
    assert.equal(secret.requests.length, 2);
  } finally {
    database.close();
  }
});

test("persistence failure on the first accepted outcome of a later page keeps full slot counts", async () => {
  const database = openDatabase();
  const leads = createLeads(database);
  let recorderCalls = 0;
  const recorder: DiscoveryLeadRecorder = {
    recordDiscoveredLead(input, recordActor) {
      recorderCalls += 1;
      return leads.recordDiscoveredLead(input, recordActor);
    },
  };
  database.exec(`
    CREATE TRIGGER business_leads_abort_failing_reference
    BEFORE INSERT ON business_leads
    WHEN NEW.source_reference = 'failing-ref'
    BEGIN SELECT RAISE(ABORT, 'sentinel persistence secret'); END
  `);
  const provider = new FakeDiscoveryProvider(providerId, [
    page([accepted("page-one-ref")], "cursor-page-2"),
    page([
      rejected(),
      accepted("failing-ref", { businessName: "Failing Business" }),
      accepted("later-ref", { businessName: "Later Business" }),
    ], "cursor-page-3"),
    page([accepted("page-three-ref")]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 10 },
      provider,
      leads: recorder,
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 10, [
      "sentinel persistence secret",
      "cursor-page-2",
      "cursor-page-3",
      "failing-ref",
      "later-ref",
    ]);
    assert.deepEqual(result.stop, {
      status: "failed",
      reason: "persistence_error",
      code: "PERSISTENCE_FAILED",
    });
    assert.equal(result.summary.pagesFetched, 2);
    assert.equal(result.summary.slotsExamined, 4);
    assert.equal(result.summary.slotsAccepted, 3);
    assert.equal(result.summary.slotsRejected, 1);
    assert.equal(result.summary.acceptedPersisted, 1);
    assert.equal(result.summary.leadsCreated, 1);
    assert.equal(result.summary.leadsDuplicate, 0);
    assert.equal(provider.requests.length, 2);
    assert.equal(recorderCalls, 2);
    const kept = discovered(database, "page-one-ref");
    assert.equal(kept?.status, "recorded");
    assert.equal(audits(database, kept?.id ?? "").length, 1);
    assert.equal(discovered(database, "failing-ref"), undefined);
    assert.equal(discovered(database, "later-ref"), undefined);
    assert.equal(discovered(database, "page-three-ref"), undefined);
    assert.equal(countRows(database, "business_leads"), 1);
  } finally {
    database.close();
  }
});

test("invalid and unexpected recorder failures keep the committed prefix and hide causes", async () => {
  const database = openDatabase();
  const ids = idSequence();
  const leads = createLeads(database, ids);
  try {
    let invalidCalls = 0;
    const invalidRecorder: DiscoveryLeadRecorder = {
      recordDiscoveredLead(input, recordActor) {
        invalidCalls += 1;
        if (input.providerReference === "invalid-ref") {
          throw new InvalidDiscoveredLeadInputError();
        }
        return leads.recordDiscoveredLead(input, recordActor);
      },
    };
    const invalidProvider = new FakeDiscoveryProvider(providerId, [
      page([
        accepted("kept-before-invalid"),
        accepted("invalid-ref"),
        accepted("after-invalid"),
      ], "cursor-more"),
      page([accepted("next-after-invalid")]),
    ]);
    const invalidResult = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 8 },
      provider: invalidProvider,
      leads: invalidRecorder,
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(invalidResult, 8, [
      "cursor-more",
      "Discovered lead input is invalid.",
      "invalid-ref",
    ]);
    assert.deepEqual(invalidResult.stop, {
      status: "failed",
      reason: "persistence_error",
      code: "INVALID_DISCOVERED_LEAD",
    });
    assert.equal(invalidResult.summary.pagesFetched, 1);
    assert.equal(invalidResult.summary.slotsExamined, 3);
    assert.equal(invalidResult.summary.slotsAccepted, 3);
    assert.equal(invalidResult.summary.acceptedPersisted, 1);
    assert.equal(invalidCalls, 2);
    assert.equal(invalidProvider.requests.length, 1);
    assert.notEqual(discovered(database, "kept-before-invalid"), undefined);
    assert.equal(discovered(database, "invalid-ref"), undefined);
    assert.equal(discovered(database, "after-invalid"), undefined);

    let unexpectedCalls = 0;
    const unexpectedRecorder: DiscoveryLeadRecorder = {
      recordDiscoveredLead(input, recordActor) {
        unexpectedCalls += 1;
        if (input.providerReference === "boom-ref") {
          throw new Error("sentinel-recorder");
        }
        return leads.recordDiscoveredLead(input, recordActor);
      },
    };
    const unexpectedProvider = new FakeDiscoveryProvider(providerId, [
      page([accepted("kept-before-unexpected"), accepted("boom-ref")]),
    ]);
    const unexpectedResult = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 8 },
      provider: unexpectedProvider,
      leads: unexpectedRecorder,
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(unexpectedResult, 8, ["sentinel-recorder", "boom-ref"]);
    assert.deepEqual(unexpectedResult.stop, {
      status: "failed",
      reason: "persistence_error",
      code: "UNEXPECTED",
    });
    assert.equal(unexpectedResult.summary.slotsExamined, 2);
    assert.equal(unexpectedResult.summary.acceptedPersisted, 1);
    assert.equal(unexpectedCalls, 2);
    assert.notEqual(discovered(database, "kept-before-unexpected"), undefined);
    assert.equal(discovered(database, "boom-ref"), undefined);
  } finally {
    database.close();
  }
});

test("cancellation before a page returns adds no slots from that request", async () => {
  const database = openDatabase();
  const preabortedProvider = new FakeDiscoveryProvider(providerId, [page([accepted("never-ref")])]);
  const controller = new AbortController();
  controller.abort();
  try {
    const preaborted = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 5 },
      provider: preabortedProvider,
      leads: createLeads(database),
      actor,
      signal: controller.signal,
    });
    assertRunInvariants(preaborted, 5);
    assert.deepEqual(preaborted.stop, { status: "cancelled", reason: "cancelled" });
    assert.equal(preaborted.summary.slotsExamined, 0);
    assert.equal(preaborted.summary.pagesFetched, 0);
    assert.equal(preabortedProvider.requests.length, 0);
    assert.equal(countRows(database, "business_leads"), 0);

    const cancelled = new ScriptedDiscoveryProvider(providerId, [
      () => page([accepted("kept-ref")], "cursor-next"),
      () => {
        throw new DiscoveryProviderError("CANCELLED");
      },
    ]);
    const afterProgress = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 5 },
      provider: cancelled,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(afterProgress, 5, ["cursor-next"]);
    assert.deepEqual(afterProgress.stop, { status: "cancelled", reason: "cancelled" });
    assert.equal(afterProgress.summary.pagesFetched, 1);
    assert.equal(afterProgress.summary.slotsExamined, 1);
    assert.equal(afterProgress.summary.leadsCreated, 1);
    assert.equal(cancelled.requests.length, 2);
    assert.notEqual(discovered(database, "kept-ref"), undefined);
  } finally {
    database.close();
  }
});

test("cancellation after a valid page leaves later accepted outcomes unpersisted", async () => {
  const database = openDatabase();
  try {
    const beforePersist = new AbortController();
    const returnedAborted = new ScriptedDiscoveryProvider(providerId, [
      () => {
        beforePersist.abort();
        return page([
          accepted("unpersisted-a"),
          rejected(),
          accepted("unpersisted-b"),
        ]);
      },
    ]);
    const inHand = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 6 },
      provider: returnedAborted,
      leads: createLeads(database),
      actor,
      signal: beforePersist.signal,
    });
    assertRunInvariants(inHand, 6);
    assert.deepEqual(inHand.stop, { status: "cancelled", reason: "cancelled" });
    assert.equal(inHand.summary.pagesFetched, 1);
    assert.equal(inHand.summary.slotsExamined, 3);
    assert.equal(inHand.summary.slotsAccepted, 2);
    assert.equal(inHand.summary.slotsRejected, 1);
    assert.equal(inHand.summary.acceptedPersisted, 0);
    assert.equal(countRows(database, "business_leads"), 0);

    const duringPersist = new AbortController();
    const leads = createLeads(database);
    let writes = 0;
    const recorder: DiscoveryLeadRecorder = {
      recordDiscoveredLead(input, recordActor) {
        const recorded = leads.recordDiscoveredLead(input, recordActor);
        writes += 1;
        if (writes === 1) {
          duringPersist.abort();
        }
        return recorded;
      },
    };
    const provider = new FakeDiscoveryProvider(providerId, [
      page([
        accepted("persisted-ref"),
        accepted("skipped-ref"),
      ], "cursor-more"),
      page([accepted("next-page-ref")]),
    ]);
    const partial = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 6 },
      provider,
      leads: recorder,
      actor,
      signal: duringPersist.signal,
    });
    assertRunInvariants(partial, 6, ["cursor-more"]);
    assert.deepEqual(partial.stop, { status: "cancelled", reason: "cancelled" });
    assert.equal(partial.summary.pagesFetched, 1);
    assert.equal(partial.summary.slotsExamined, 2);
    assert.equal(partial.summary.slotsAccepted, 2);
    assert.equal(partial.summary.acceptedPersisted, 1);
    assert.equal(partial.summary.leadsCreated, 1);
    assert.equal(writes, 1);
    assert.equal(provider.requests.length, 1);
    assert.notEqual(discovered(database, "persisted-ref"), undefined);
    assert.equal(discovered(database, "skipped-ref"), undefined);
    assert.equal(discovered(database, "next-page-ref"), undefined);
  } finally {
    database.close();
  }
});

test("an archived suppressed duplicate stays archived and suppressed", async () => {
  const database = openDatabase();
  const leads = createLeads(database);
  const seeded = leads.recordDiscoveredLead({
    provider: providerId,
    providerReference: "archived-ref",
    businessName: "Original Name",
    websiteObservation: { presence: "present", url: "https://original.example/" },
  }, actor);
  leads.transitionLead(seeded.lead.id, "archived", seeded.lead.version, actor);
  new DoNotContactService(database).applySuppression(seeded.lead.id, "manual", actor);
  const before = audits(database, seeded.lead.id);
  const provider = new FakeDiscoveryProvider(providerId, [
    page([
      accepted("archived-ref", {
        businessName: "Replacement Name",
        websiteObservation: { presence: "unknown" },
      }),
    ]),
  ]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 3 },
      provider,
      leads,
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 3);
    assert.equal(result.summary.slotsExamined, 1);
    assert.equal(result.summary.acceptedPersisted, 1);
    assert.equal(result.summary.leadsDuplicate, 1);
    assert.equal(result.summary.leadsCreated, 0);
    const stored = discovered(database, "archived-ref");
    assert.equal(stored?.status, "archived");
    assert.equal(stored?.businessName, "Original Name");
    assert.deepEqual(stored?.websiteObservation, seeded.lead.websiteObservation);
    assert.equal(countRows(database, "lead_contact_suppressions"), 1);
    assert.deepEqual(audits(database, seeded.lead.id), before);
  } finally {
    database.close();
  }
});

test("the explicit actor is stored on the created lead audit event", async () => {
  const database = openDatabase();
  const operator: AuditActor = { type: "human", id: "  dq-014-operator  " };
  const provider = new FakeDiscoveryProvider(providerId, [page([accepted("actor-ref")])]);
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 2 },
      provider,
      leads: createLeads(database),
      actor: operator,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 2, ["dq-014-operator"]);
    const lead = discovered(database, "actor-ref");
    assert.deepEqual(audits(database, lead?.id ?? ""), [{
      eventType: "lead.created",
      actor: { type: "human", id: "dq-014-operator" },
      details: { initialStatus: "recorded", initialWebsitePresence: "unknown", version: 1 },
    }]);
  } finally {
    database.close();
  }
});

test("preflight failures reject before any provider call or write", async () => {
  const database = openDatabase();
  const provider = new FakeDiscoveryProvider(providerId, [page([accepted("should-not")])]);
  const leads = createLeads(database);
  const signal = new AbortController().signal;
  try {
    await assert.rejects(
      () => runBoundedDiscovery({
        criteria: { location: " ", query },
        provider,
        leads,
        actor,
        signal,
      }),
      InvalidDiscoveryCriteriaError,
    );
    await assert.rejects(
      () => runBoundedDiscovery({
        criteria: { location, query },
        provider,
        leads,
        actor: { type: "human", id: "\n" },
        signal,
      }),
      InvalidAuditActorError,
    );
    await assert.rejects(
      () => runBoundedDiscovery({
        criteria: { location, query },
        provider,
        leads,
        actor,
        signal: undefined as never,
      }),
      (error: unknown) => error instanceof DiscoveryProviderError && error.code === "INVALID_REQUEST",
    );
    await assert.rejects(
      () => runBoundedDiscovery({
        criteria: { location, query },
        provider: { id: providerId } as DiscoveryProvider,
        leads,
        actor,
        signal,
      }),
      (error: unknown) => error instanceof DiscoveryProviderError && error.code === "INVALID_REQUEST",
    );
    assert.equal(provider.requests.length, 0);
    assert.equal(countRows(database, "business_leads"), 0);
    assert.equal(countRows(database, "audit_events"), 0);
  } finally {
    database.close();
  }
});

test("the bounded run performs no network access", async () => {
  const database = openDatabase();
  const provider = new FakeDiscoveryProvider(providerId, [page([accepted("offline-ref")])]);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("network disabled");
  }) as typeof fetch;
  try {
    const result = await runBoundedDiscovery({
      criteria: { location, query, maxResults: 2 },
      provider,
      leads: createLeads(database),
      actor,
      signal: new AbortController().signal,
    });
    assertRunInvariants(result, 2);
    assert.equal(result.summary.leadsCreated, 1);
    assert.equal(fetchCalls, 0);
    const source = readFileSync(join(process.cwd(), "src/discovery/run.ts"), "utf8");
    const imports = source.split("\n").filter((line) => line.startsWith("import ")).join("\n");
    for (const forbidden of [
      "geoapify",
      "../config",
      "../compliance",
      "../network-safety",
      "../db",
      "node:dns",
      "node:http",
      "node:https",
      "node:fs",
      "better-sqlite3",
    ]) {
      assert.equal(imports.includes(forbidden), false, forbidden);
    }
    assert.equal(source.includes("process.env"), false);
    assert.equal(source.includes("fetch("), false);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
