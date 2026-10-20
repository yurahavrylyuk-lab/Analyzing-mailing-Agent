import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { DatabaseAuditRepository } from "../../src/audit";
import { DoNotContactService } from "../../src/compliance";
import { createDatabase, SqliteDatabase, type Database } from "../../src/db";
import { runDiscoveryCommand, type DiscoveryPage } from "../../src/discovery";
import { DatabaseLeadRepository } from "../../src/leads";
import { FakeDiscoveryProvider } from "../helpers/fake-discovery-provider";

const actorId = "ada-operator";
const providerReference = "osm:n:15";
const businessName = "Harbor Cafe";
const apiKey = "integration-sentinel-key";

function acceptedPage(): DiscoveryPage {
  return {
    outcomes: [
      {
        status: "accepted",
        candidate: {
          provider: "geoapify",
          providerReference,
          businessName,
          websiteObservation: { presence: "unknown" },
        },
        warnings: [],
      },
    ],
  };
}

function suppressionSnapshot(database: Database) {
  return database.get<{
    lead_id: string;
    reason_code: string;
    applied_at: string;
    applied_by_type: string;
    applied_by_id: string;
  }>(
    `SELECT lead_id, reason_code, applied_at, applied_by_type, applied_by_id
     FROM lead_contact_suppressions`,
  );
}

function createdActors(database: Database) {
  return database.all<{ actor_type: string; actor_id: string }>(
    `SELECT actor_type, actor_id
     FROM audit_events
     WHERE event_type = 'lead.created'
     ORDER BY id`,
  );
}

describe("DQ-015 discovery command integration", { concurrency: false }, () => {
  test("persists one human-audited lead, then a duplicate that preserves suppression", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dq-015-command-"));
    const databasePath = join(directory, "discovery.sqlite");
    const databaseUrl: `file:${string}` = `file:${databasePath}`;
    const env = {
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      DISCOVERY_PROVIDER: "geoapify",
      GEOAPIFY_API_KEY: apiKey,
    };
    const provider = new FakeDiscoveryProvider("geoapify", [acceptedPage(), acceptedPage()]);
    const argv = ["--location", "Kyiv", "--query", "cafe", "--actor", actorId];
    const originalClose = SqliteDatabase.prototype.close;
    let closes = 0;
    SqliteDatabase.prototype.close = function patchedClose(this: SqliteDatabase) {
      closes += 1;
      return originalClose.call(this);
    };
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("live-network-sentinel");
    }) as typeof fetch;

    try {
      const first = await runDiscoveryCommand(
        { argv, env, signal: new AbortController().signal },
        { createProvider: () => provider },
      );
      assert.equal(closes, 1);
      assert.equal(fetchCalls, 0);
      assert.equal(first.exitCode, 0);
      assert.equal(first.stderr, "");
      assert.match(first.stdout, /leadsCreated: 1/);
      assert.match(first.stdout, /leadsDuplicate: 0/);
      assert.equal(`${first.stdout}${first.stderr}`.includes(apiKey), false);
      assert.equal(`${first.stdout}${first.stderr}`.includes(actorId), false);

      const inspected = createDatabase({ url: databaseUrl });
      let seededSuppression: ReturnType<typeof suppressionSnapshot>;
      try {
        const lead = new DatabaseLeadRepository(inspected).findByDiscoveryIdentity(
          "geoapify",
          providerReference,
        );
        assert.ok(lead);
        assert.equal(lead.businessName, businessName);
        const events = new DatabaseAuditRepository(inspected).listForEntity(
          "business_lead",
          lead.id,
        );
        assert.equal(events.length, 1);
        assert.equal(events[0]?.eventType, "lead.created");
        assert.deepEqual(events[0]?.actor, { type: "human", id: actorId });
        const seeded = new DoNotContactService(inspected).applySuppression(lead.id, "manual", {
          type: "human",
          id: "seed-operator",
        });
        assert.equal(seeded.changed, true);
        seededSuppression = suppressionSnapshot(inspected);
        assert.equal(seededSuppression?.applied_by_id, "seed-operator");
      } finally {
        inspected.close();
      }

      const closesBeforeSecond = closes;
      const second = await runDiscoveryCommand(
        { argv, env, signal: new AbortController().signal },
        { createProvider: () => provider },
      );
      assert.equal(closes, closesBeforeSecond + 1);
      assert.equal(fetchCalls, 0);
      assert.equal(second.exitCode, 0);
      assert.equal(second.stderr, "");
      assert.match(second.stdout, /leadsCreated: 0/);
      assert.match(second.stdout, /leadsDuplicate: 1/);
      assert.equal(provider.requests.length, 2);
      assert.ok(provider.requests[0]?.signal instanceof AbortSignal);
      assert.ok(provider.requests[1]?.signal instanceof AbortSignal);

      const after = createDatabase({ url: databaseUrl });
      try {
        const leads = after.get<{ count: number }>(`SELECT count(*) AS count FROM business_leads`);
        assert.equal(leads?.count, 1);
        assert.deepEqual(createdActors(after), [{ actor_type: "human", actor_id: actorId }]);
        assert.deepEqual(suppressionSnapshot(after), seededSuppression);
        const eventTypes = after
          .all<{ event_type: string }>(`SELECT event_type FROM audit_events ORDER BY id`)
          .map((event) => event.event_type);
        assert.deepEqual(eventTypes, ["lead.created", "lead.do_not_contact_applied"]);
      } finally {
        after.close();
      }
    } finally {
      SqliteDatabase.prototype.close = originalClose;
      globalThis.fetch = originalFetch;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a migration failure does not construct a provider", async () => {
    let providerCalls = 0;
    const result = await runDiscoveryCommand(
      {
        argv: ["--location", "Kyiv", "--query", "cafe", "--actor", actorId],
        env: {
          NODE_ENV: "test",
          DISCOVERY_PROVIDER: "geoapify",
          GEOAPIFY_API_KEY: apiKey,
        },
        signal: new AbortController().signal,
      },
      {
        openDatabase() {
          throw new Error("migration failed at secret-schema.sql");
        },
        createProvider() {
          providerCalls += 1;
          throw new Error("provider-sentinel");
        },
      },
    );

    assert.equal(providerCalls, 0);
    assert.equal(result.exitCode, 4);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Discovery database is unavailable.\n");
    assert.equal(result.stderr.includes("secret-schema"), false);
    assert.equal(result.stderr.includes(apiKey), false);
  });
});
