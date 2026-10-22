import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  validateWebsiteAnalysis,
  WEBSITE_ANALYSIS_ERROR_CODES,
  WebsiteAnalysisError,
} from "../../src/website-analysis";
import type { WebsiteAnalysis, WebsiteFacts } from "../../src/website-analysis";

const leadId = "00000000-0000-4000-8000-000000000001";

function facts(): WebsiteFacts {
  return Object.freeze({
    evidenceId: 17,
    leadId,
    leadVersion: 4,
    requestedUrl: "https://www.example.com/requested",
    finalUrl: "https://www.example.com/landing",
    title: "Delta",
    metaDescription: "Services",
    documentLanguage: "en",
    hasViewport: true,
    h1Count: 1,
    headingCount: 2,
    imageCount: 1,
    imagesWithoutAlt: 0,
    formCount: 1,
    internalLinkCount: 2,
    externalLinkCount: 1,
    visibleText: "Hello",
  });
}

function candidate(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    evidenceId: 17,
    leadId,
    leadVersion: 4,
    summary: "The page states its services.",
    findings: [],
    ...overrides,
  };
}

function assertInvalid(run: () => void): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof WebsiteAnalysisError &&
      error.name === "WebsiteAnalysisError" &&
      error.code === "INVALID_ANALYSIS" &&
      error.message === "Website analysis is invalid." &&
      !("cause" in error),
  );
}

function assertMismatch(run: () => void): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof WebsiteAnalysisError &&
      error.name === "WebsiteAnalysisError" &&
      error.code === "ANALYSIS_IDENTITY_MISMATCH" &&
      error.message === "Website analysis identity does not match the website facts." &&
      !("cause" in error) &&
      !error.message.includes("secret-model-output"),
  );
}

test("publishes the fixed website analysis error codes and messages", () => {
  assert.equal(Object.isFrozen(WEBSITE_ANALYSIS_ERROR_CODES), true);
  assert.deepEqual(
    [...WEBSITE_ANALYSIS_ERROR_CODES],
    ["INVALID_ANALYSIS", "ANALYSIS_IDENTITY_MISMATCH"],
  );
  const invalid = new WebsiteAnalysisError("INVALID_ANALYSIS");
  assert.equal(invalid.name, "WebsiteAnalysisError");
  assert.equal(invalid.message, "Website analysis is invalid.");
  assert.equal("cause" in invalid, false);
  const mismatch = new WebsiteAnalysisError("ANALYSIS_IDENTITY_MISMATCH");
  assert.equal(
    mismatch.message,
    "Website analysis identity does not match the website facts.",
  );
  assert.equal("cause" in mismatch, false);
});

test("accepts a trimmed summary, zero findings, and the facts identity", () => {
  const source = facts();
  const result = validateWebsiteAnalysis(
    source,
    candidate({ summary: "  The page states its services.  " }),
  );
  assert.deepEqual(result, {
    evidenceId: source.evidenceId,
    leadId: source.leadId,
    leadVersion: source.leadVersion,
    summary: "The page states its services.",
    findings: [],
  } satisfies WebsiteAnalysis);
  assert.deepEqual(Object.keys(result), [
    "evidenceId",
    "leadId",
    "leadVersion",
    "summary",
    "findings",
  ]);
  assert.equal("provider" in result, false);
  assert.equal("score" in result, false);
  assert.equal("opportunities" in result, false);
});

test("rejects non-object roots before identity comparison", () => {
  const mismatchedArray = Object.assign(["row"], {
    evidenceId: 99,
    leadId: "other-lead",
    leadVersion: 8,
    summary: "Present.",
    findings: [],
  });
  for (const root of [null, mismatchedArray, "analysis", 17, true, undefined]) {
    assertInvalid(() => validateWebsiteAnalysis(facts(), root));
  }
});

test("rejects missing own keys, extra own keys, and wrong identity types", () => {
  const missingSummary = candidate();
  delete missingSummary.summary;
  assertInvalid(() => validateWebsiteAnalysis(facts(), missingSummary));

  const missingIdentity = candidate();
  delete missingIdentity.evidenceId;
  assertInvalid(() => validateWebsiteAnalysis(facts(), missingIdentity));

  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ provider: "secret-model-output" })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ evidenceId: "17" })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ evidenceId: "123" })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ leadId: 17 })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ leadVersion: "4" })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ summary: new String("Ready") })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ summary: 12 })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ findings: {} })),
  );
});

test("rejects inherited required keys and ignores inherited extra keys", () => {
  const inheritedRequired = Object.create({
    evidenceId: 99,
    summary: "Inherited summary.",
    leaked: "hidden",
  });
  inheritedRequired.leadId = leadId;
  inheritedRequired.leadVersion = 4;
  inheritedRequired.findings = [];
  assertInvalid(() => validateWebsiteAnalysis(facts(), inheritedRequired));

  const inheritedExtra = Object.create({
    provider: "hidden",
    summary: "Prototype summary.",
  });
  Object.assign(inheritedExtra, candidate({ summary: "  Actual summary.  " }));
  const result = validateWebsiteAnalysis(facts(), inheritedExtra);
  assert.equal(result.summary, "Actual summary.");
  assert.equal("provider" in result, false);

  const inheritedFinding = Object.create({
    evidence: "Inherited evidence.",
    score: 1,
  });
  inheritedFinding.category = "seo";
  inheritedFinding.severity = "low";
  inheritedFinding.observation = "The title is short.";
  inheritedFinding.recommendation = "Expand the title.";
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ findings: [inheritedFinding] })),
  );

  const shadowedFinding = Object.create({ score: 1, evidence: "Prototype evidence." });
  Object.assign(shadowedFinding, {
    category: "accessibility",
    severity: "high",
    observation: "  One image has no alt.  ",
    evidence: "  imagesWithoutAlt is 1.  ",
    recommendation: "  Add an alt description.  ",
  });
  const shadowed = validateWebsiteAnalysis(
    facts(),
    candidate({ findings: [shadowedFinding] }),
  );
  assert.equal(shadowed.findings.length, 1);
  assert.equal(shadowed.findings[0].evidence, "imagesWithoutAlt is 1.");
  assert.equal("score" in shadowed.findings[0], false);
});

test("rejects each mismatched identity field", () => {
  assertMismatch(() =>
    validateWebsiteAnalysis(facts(), candidate({ evidenceId: 18 })),
  );
  assertMismatch(() =>
    validateWebsiteAnalysis(facts(), candidate({ leadId: `${leadId}-other` })),
  );
  assertMismatch(() =>
    validateWebsiteAnalysis(facts(), candidate({ leadVersion: 5 })),
  );
});

test("rejects a typed identity mismatch before other schema defects", () => {
  assertMismatch(() =>
    validateWebsiteAnalysis(
      facts(),
      candidate({
        evidenceId: 18,
        summary: "x".repeat(801),
        provider: "secret-model-output",
        findings: [{ category: "SEO" }],
      }),
    ),
  );
});

test("accepts the inclusive 800-character summary and rejects one over", () => {
  const accepted = validateWebsiteAnalysis(
    facts(),
    candidate({ summary: `  ${"a".repeat(800)}  ` }),
  );
  assert.equal(accepted.summary.length, 800);
  assert.equal(accepted.summary, "a".repeat(800));

  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ summary: ` ${"a".repeat(801)}` })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ summary: " \n\t " })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ summary: "" })),
  );

  const spaced = validateWebsiteAnalysis(
    facts(),
    candidate({ summary: "  Alpha   Beta  " }),
  );
  assert.equal(spaced.summary, "Alpha   Beta");
});
function sampleFinding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    category: "seo",
    severity: "medium",
    observation: "The title is short.",
    evidence: "title is Delta.",
    recommendation: "Expand the title.",
    ...overrides,
  };
}

test("accepts every category and severity", () => {
  const findings = [
    sampleFinding({ category: "design", severity: "low", observation: "The layout reads as dated." }),
    sampleFinding({ category: "usability", severity: "medium", observation: "The form is easy to miss." }),
    sampleFinding({ category: "seo", severity: "high", observation: "The title is short." }),
    sampleFinding({ category: "accessibility", severity: "low", observation: "One image has no alt." }),
    sampleFinding({
      category: "conversion",
      severity: "medium",
      observation: "The page has no clear primary CTA.",
    }),
  ];
  const result = validateWebsiteAnalysis(facts(), candidate({ findings }));
  assert.deepEqual(
    result.findings.map((finding) => [finding.category, finding.severity]),
    [
      ["design", "low"],
      ["usability", "medium"],
      ["seo", "high"],
      ["accessibility", "low"],
      ["conversion", "medium"],
    ],
  );
  assert.equal("score" in result, false);
  assert.equal(result.findings.every((finding) => !("opportunities" in finding)), true);
});

test("rejects unknown and case-mismatched category and severity", () => {
  for (const category of ["SEO", "Design", "content", ""]) {
    assertInvalid(() =>
      validateWebsiteAnalysis(
        facts(),
        candidate({ findings: [sampleFinding({ category })] }),
      ),
    );
  }
  for (const severity of ["High", "LOW", "MEDIUM", "critical"]) {
    assertInvalid(() =>
      validateWebsiteAnalysis(
        facts(),
        candidate({ findings: [sampleFinding({ severity })] }),
      ),
    );
  }
  assertInvalid(() =>
    validateWebsiteAnalysis(
      facts(),
      candidate({ findings: [sampleFinding({ category: new String("seo") })] }),
    ),
  );
});

test("rejects a finding that is not a plain object or has the wrong own keys", () => {
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ findings: [null] })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ findings: [["seo"]] })),
  );
  const missingEvidence = sampleFinding();
  delete missingEvidence.evidence;
  assertInvalid(() =>
    validateWebsiteAnalysis(facts(), candidate({ findings: [missingEvidence] })),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(
      facts(),
      candidate({ findings: [sampleFinding({ score: 9 })] }),
    ),
  );
});

test("accepts exact text bounds after trim and rejects one code unit over", () => {
  const emojiBound = `${"a".repeat(798)}😀`;
  const accepted = validateWebsiteAnalysis(
    facts(),
    candidate({
      summary: `  ${"s".repeat(800)}  `,
      findings: [
        sampleFinding({
          observation: ` ${"b".repeat(500)} `,
          evidence: `\n${emojiBound}\n`,
          recommendation: `\t${"d".repeat(500)}\t`,
        }),
      ],
    }),
  );
  assert.equal(accepted.summary.length, 800);
  assert.equal(accepted.findings[0].observation.length, 500);
  assert.equal(accepted.findings[0].evidence.length, 800);
  assert.equal(accepted.findings[0].evidence, emojiBound);
  assert.equal(accepted.findings[0].recommendation.length, 500);
  assert.equal(accepted.findings[0].observation, "b".repeat(500));

  assertInvalid(() =>
    validateWebsiteAnalysis(
      facts(),
      candidate({
        findings: [sampleFinding({ observation: "o".repeat(501) })],
      }),
    ),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(
      facts(),
      candidate({
        findings: [sampleFinding({ recommendation: "r".repeat(501) })],
      }),
    ),
  );
  assertInvalid(() =>
    validateWebsiteAnalysis(
      facts(),
      candidate({
        findings: [sampleFinding({ evidence: `${"a".repeat(799)}😀` })],
      }),
    ),
  );
});

test("rejects empty and whitespace-only finding text", () => {
  for (const field of ["observation", "evidence", "recommendation"]) {
    assertInvalid(() =>
      validateWebsiteAnalysis(
        facts(),
        candidate({ findings: [sampleFinding({ [field]: "" })] }),
      ),
    );
    assertInvalid(() =>
      validateWebsiteAnalysis(
        facts(),
        candidate({ findings: [sampleFinding({ [field]: " \n\t " })] }),
      ),
    );
  }
  const preserved = validateWebsiteAnalysis(
    facts(),
    candidate({
      findings: [sampleFinding({ observation: "  Keep   the gap  " })],
    }),
  );
  assert.equal(preserved.findings[0].observation, "Keep   the gap");
});

test("preserves submitted finding order and duplicate findings", () => {
  const first = sampleFinding({
    category: "design",
    observation: "Same observation.",
    evidence: "Same evidence.",
    recommendation: "Same recommendation.",
  });
  const second = sampleFinding({
    category: "conversion",
    observation: "Same observation.",
    evidence: "Same evidence.",
    recommendation: "Same recommendation.",
  });
  const third = { ...first };
  const result = validateWebsiteAnalysis(
    facts(),
    candidate({ findings: [first, second, third] }),
  );
  assert.deepEqual(
    result.findings.map((finding) => finding.category),
    ["design", "conversion", "design"],
  );
  assert.equal(result.findings[0].observation, result.findings[2].observation);
  assert.notEqual(result.findings[0], result.findings[2]);

  const eight = [
    ...Array.from({ length: 3 }, () => sampleFinding({ category: "design" })),
    ...Array.from({ length: 3 }, () => sampleFinding({ category: "usability" })),
    ...Array.from({ length: 2 }, () => sampleFinding({ category: "seo" })),
  ];
  const bounded = validateWebsiteAnalysis(facts(), candidate({ findings: eight }));
  assert.deepEqual(
    bounded.findings.map((finding) => finding.category),
    [
      "design",
      "design",
      "design",
      "usability",
      "usability",
      "usability",
      "seo",
      "seo",
    ],
  );
});

test("rejects four findings in one category while the total stays within eight", () => {
  const three = validateWebsiteAnalysis(
    facts(),
    candidate({
      findings: [sampleFinding(), sampleFinding(), sampleFinding()],
    }),
  );
  assert.equal(three.findings.length, 3);
  assert.equal(three.findings.every((finding) => finding.category === "seo"), true);

  assertInvalid(() =>
    validateWebsiteAnalysis(
      facts(),
      candidate({
        findings: [
          sampleFinding(),
          sampleFinding(),
          sampleFinding(),
          sampleFinding(),
        ],
      }),
    ),
  );
});

test("rejects nine findings", () => {
  const findings = [
    ...Array.from({ length: 3 }, () => sampleFinding({ category: "design" })),
    ...Array.from({ length: 3 }, () => sampleFinding({ category: "usability" })),
    ...Array.from({ length: 2 }, () => sampleFinding({ category: "seo" })),
    sampleFinding({ category: "accessibility" }),
  ];
  assert.equal(findings.length, 9);
  assertInvalid(() => validateWebsiteAnalysis(facts(), candidate({ findings })));
});
test("freezes the analysis and leaves facts and the candidate unchanged", () => {
  const source: WebsiteFacts = { ...facts() };
  const inputFinding = sampleFinding({ observation: "  spaced   text  " });
  const input = candidate({
    summary: "  Frozen summary.  ",
    findings: [inputFinding],
  });
  const findingsReference = input.findings;
  const beforeFacts = { ...source };
  const beforeSummary = input.summary;
  const beforeObservation = inputFinding.observation;

  const first = validateWebsiteAnalysis(source, input);
  const second = validateWebsiteAnalysis(source, input);

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.findings), true);
  assert.equal(first.findings.length, 1);
  assert.equal(Object.isFrozen(first.findings[0]), true);
  assert.equal(first.summary, "Frozen summary.");
  assert.equal(first.findings[0].observation, "spaced   text");
  assert.notEqual(first.findings, findingsReference);
  assert.notEqual(first.findings[0], inputFinding);

  assert.deepEqual(source, beforeFacts);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(input.summary, beforeSummary);
  assert.equal(input.findings, findingsReference);
  assert.equal(inputFinding.observation, beforeObservation);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(inputFinding), false);
  assert.equal(Object.isFrozen(findingsReference), false);

  const empty = validateWebsiteAnalysis(source, candidate());
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(Object.isFrozen(empty.findings), true);
  assert.equal(empty.findings.length, 0);
});

test("validation does not call fetch or read the clock", () => {
  const source = facts();
  const input = candidate();
  const realFetch = globalThis.fetch;
  const RealDate = globalThis.Date;
  let fetchCalls = 0;
  let dateNowCalls = 0;
  let dateConstructs = 0;

  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("network");
  }) as typeof fetch;

  function wrappedDate(): Date {
    dateConstructs += 1;
    return new RealDate();
  }

  const wrapped = wrappedDate as unknown as DateConstructor;
  wrapped.now = () => {
    dateNowCalls += 1;
    return 0;
  };
  wrapped.parse = RealDate.parse;
  wrapped.UTC = RealDate.UTC;
  Object.defineProperty(wrapped, "prototype", { value: RealDate.prototype });
  globalThis.Date = wrapped;

  try {
    const result = validateWebsiteAnalysis(source, input);
    assert.equal(result.evidenceId, source.evidenceId);
    assert.equal(fetchCalls, 0);
    assert.equal(dateNowCalls, 0);
    assert.equal(dateConstructs, 0);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.Date = RealDate;
  }
});
