import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  InvalidAuditActorError,
  InvalidAuditEventError,
  MAX_AUDIT_DETAILS_BYTES,
  OversizedAuditDetailsError,
  normalizeAuditActor,
  normalizeAuditEventInput,
  type AuditEventInput,
} from "../../src/audit";

const validEvent: AuditEventInput = {
  occurredAt: "2026-01-01T00:00:00.000Z",
  eventType: "lead.created",
  entityType: "business_lead",
  entityId: "lead-1",
  actor: { type: "human", id: "reviewer" },
  details: {
    initialStatus: "recorded",
    initialWebsitePresence: "unknown",
    version: 1,
  },
};

test("normalizes actor IDs without changing attribution type", () => {
  assert.deepEqual(normalizeAuditActor({ type: "system", id: "  importer  " }), {
    type: "system",
    id: "importer",
  });
});

test("rejects blank, controlled, oversized, and unsupported actors safely", () => {
  for (const actor of [
    { type: "human", id: "   " },
    { type: "human", id: "line\nbreak" },
    { type: "system", id: "x".repeat(129) },
    { type: "service", id: "worker" },
  ]) {
    assert.throws(
      () => normalizeAuditActor(actor as never),
      (error: unknown) =>
        error instanceof InvalidAuditActorError &&
        !error.message.includes(String(actor.id)),
    );
  }
});

test("rejects control characters at either edge of the original actor ID", () => {
  for (const id of [
    "\tworker",
    "worker\t",
    "\tworker\t",
    "\nworker",
    "worker\n",
    "\rworker",
    "worker\r",
  ]) {
    assert.throws(
      () => normalizeAuditActor({ type: "human", id }),
      InvalidAuditActorError,
    );
  }

  assert.equal(normalizeAuditActor({ type: "human", id: "  worker  " }).id, "worker");
});

test("accepts exactly 128 Unicode characters in actor IDs", () => {
  const id = "😀".repeat(128);
  assert.equal(normalizeAuditActor({ type: "human", id }).id, id);
});

test("rejects unsupported audit detail fields including raw website URLs", () => {
  const details = {
    ...validEvent.details,
    websiteUrl: "https://user:secret@example.com/private",
  };

  assert.throws(
    () => normalizeAuditEventInput({ ...validEvent, details } as AuditEventInput),
    InvalidAuditEventError,
  );
});

test("rejects details larger than the UTF-8 byte limit", () => {
  const oversized = {
    ...validEvent.details,
    padding: "é".repeat(MAX_AUDIT_DETAILS_BYTES),
  };

  assert.throws(
    () =>
      normalizeAuditEventInput({
        ...validEvent,
        details: oversized,
      } as AuditEventInput),
    OversizedAuditDetailsError,
  );
});

test("rejects malformed event-specific details", () => {
  for (const details of [
    { initialStatus: "recorded", initialWebsitePresence: "unknown", version: 0 },
    { initialStatus: "reviewing", initialWebsitePresence: "online", version: 1 },
    null,
  ]) {
    assert.throws(
      () => normalizeAuditEventInput({ ...validEvent, details } as AuditEventInput),
      InvalidAuditEventError,
    );
  }
});

test("accepts only the exact do-not-contact audit detail shape", () => {
  const event = {
    ...validEvent,
    eventType: "lead.do_not_contact_applied" as const,
    details: { reasonCode: "requested" as const },
  };
  assert.deepEqual(normalizeAuditEventInput(event).details, {
    reasonCode: "requested",
  });
  assert.throws(
    () => normalizeAuditEventInput({
      ...event,
      details: { reasonCode: "manual", notes: "not allowed" },
    } as never),
    InvalidAuditEventError,
  );
});
