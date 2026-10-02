import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createBusinessLead,
  normalizeWebsiteObservation,
  normalizeWebsiteUrl,
  validateLifecycleTransition,
  type CreateLeadInput,
  type LeadStatus,
  type WebsiteObservation,
} from "../../src/leads/domain";
import {
  InvalidLeadInputError,
  InvalidLeadTransitionError,
} from "../../src/leads/errors";

const validInput: CreateLeadInput = {
  businessName: "  Example Business  ",
  sourceKind: "manual",
  sourceReference: "  manual-entry-1  ",
  websiteObservation: { presence: "unknown" },
};

test("creates a deterministic, trimmed recorded lead", () => {
  const lead = createBusinessLead(
    validInput,
    "00000000-0000-4000-8000-000000000001",
    new Date("2026-01-02T03:04:05.000Z"),
  );

  assert.deepEqual(lead, {
    id: "00000000-0000-4000-8000-000000000001",
    businessName: "Example Business",
    sourceKind: "manual",
    sourceReference: "manual-entry-1",
    status: "recorded",
    websiteObservation: { presence: "unknown" },
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    version: 1,
  });
  assert.ok(Object.isFrozen(lead));
  assert.ok(Object.isFrozen(lead.websiteObservation));
});

test("rejects invalid required lead fields and generated IDs", () => {
  assert.throws(
    () =>
      createBusinessLead(
        { ...validInput, businessName: "  " },
        "00000000-0000-4000-8000-000000000001",
        new Date(),
      ),
    InvalidLeadInputError,
  );
  assert.throws(
    () =>
      createBusinessLead(
        { ...validInput, sourceReference: "" },
        "00000000-0000-4000-8000-000000000001",
        new Date(),
      ),
    InvalidLeadInputError,
  );
  assert.throws(
    () =>
      createBusinessLead(
        { ...validInput, sourceKind: "provider" as "manual" },
        "00000000-0000-4000-8000-000000000001",
        new Date(),
      ),
    InvalidLeadInputError,
  );
  assert.throws(
    () => createBusinessLead(validInput, "not-a-uuid", new Date()),
    InvalidLeadInputError,
  );
});

test("normalizes absolute HTTP and HTTPS website URLs", () => {
  assert.equal(normalizeWebsiteUrl(" HTTPS://Example.COM/path "), "https://example.com/path");
  assert.deepEqual(
    normalizeWebsiteObservation({ presence: "present", url: "http://example.com" }),
    { presence: "present", url: "http://example.com/" },
  );
});

test("rejects malformed, relative, non-HTTP, and credential-bearing URLs", () => {
  for (const url of [
    "not a URL",
    "/relative",
    "ftp://example.com/file",
    "https://user:password@example.com/",
  ]) {
    assert.throws(() => normalizeWebsiteUrl(url), InvalidLeadInputError);
  }
});

test("enforces website observation shape", () => {
  assert.deepEqual(normalizeWebsiteObservation({ presence: "unknown" }), {
    presence: "unknown",
  });
  assert.deepEqual(normalizeWebsiteObservation({ presence: "missing" }), {
    presence: "missing",
  });
  assert.throws(
    () =>
      normalizeWebsiteObservation({
        presence: "missing",
        url: "https://example.com",
      } as WebsiteObservation),
    InvalidLeadInputError,
  );
  assert.throws(
    () => normalizeWebsiteObservation({ presence: "present", url: "" }),
    InvalidLeadInputError,
  );
});

test("implements the complete lifecycle transition matrix", () => {
  const expectations: ReadonlyArray<
    readonly [LeadStatus, LeadStatus, "change" | "noop" | "invalid"]
  > = [
    ["recorded", "recorded", "noop"],
    ["recorded", "reviewing", "change"],
    ["recorded", "archived", "change"],
    ["reviewing", "recorded", "invalid"],
    ["reviewing", "reviewing", "noop"],
    ["reviewing", "archived", "change"],
    ["archived", "recorded", "invalid"],
    ["archived", "reviewing", "change"],
    ["archived", "archived", "noop"],
  ];

  for (const [from, to, expectation] of expectations) {
    if (expectation === "invalid") {
      assert.throws(
        () => validateLifecycleTransition(from, to),
        InvalidLeadTransitionError,
      );
    } else {
      assert.equal(validateLifecycleTransition(from, to), expectation === "change");
    }
  }
});
