# DQ-031 Provider-Neutral Website Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate one `WebsiteFacts` value plus one untrusted candidate into one frozen provider-neutral `WebsiteAnalysis`, or throw `WebsiteAnalysisError`.

**Architecture:** Extend `src/website-analysis/` with a manual validator. `validateWebsiteAnalysis` checks the candidate's own keys and primitive types, copies the matched identity from `WebsiteFacts`, trims approved text fields, and returns a freshly frozen result. It does not call a provider or interpret whether a finding is true.

**Tech Stack:** TypeScript, Node.js, `node:test`, and `node:assert/strict`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-22-dq-031-provider-neutral-website-analysis-design.md`

## Global Constraints

- Implement only the approved spec. Do not edit the spec or this plan. Do not start DQ-032.
- Builder execution creates `feature/dq-031-provider-neutral-website-analysis` from the approved plan commit on `design/dq-031-provider-neutral-website-analysis`. Do not implement on `main` or on the design branch.
- Builder execution leaves the final implementation unstaged and uncommitted for Analyst review. The commit commands in each task are checkpoints for after APPROVED. Do not run them during Builder execution. Do not push, open a pull request, or merge in this plan.
- The only runtime responsibility is `WebsiteFacts` + `unknown` → `validateWebsiteAnalysis()` → frozen `WebsiteAnalysis`.
- The public validator is exactly `validateWebsiteAnalysis(facts: WebsiteFacts, candidate: unknown): WebsiteAnalysis`.
- Reuse `WebsiteFacts` from `src/website-analysis/facts.ts`. Do not create `WebsiteAnalysisInput` or any other duplicate DTO.
- Categories are exactly `design`, `usability`, `seo`, `accessibility`, and `conversion`. Severities are exactly `low`, `medium`, and `high`.
- `WebsiteAnalysisFinding` is a readonly object with `category`, `severity`, `observation`, `evidence`, and `recommendation`.
- `WebsiteAnalysis` is a readonly object with `evidenceId`, `leadId`, `leadVersion`, `summary`, and `findings`. It has no provider, model, fallback, latency, token, request id, score, or opportunities field.
- `WebsiteAnalysisError` codes are exactly `INVALID_ANALYSIS` and `ANALYSIS_IDENTITY_MISMATCH`, in that order. Match `src/website-analysis/errors.ts`: a frozen `as const` code array, a fixed message record, `readonly name = "WebsiteAnalysisError"`, and `constructor(readonly code)`. Do not set `cause`. Messages are `Website analysis is invalid.` and `Website analysis identity does not match the website facts.` Do not put candidate text, provider names, or model output in either message.
- No new npm dependency. Do not add Zod, Joi, Ajv, JSON Schema, an AI SDK, or a provider package. Do not modify `package.json` or `package-lock.json`.
- Create `src/website-analysis/analysis.ts` and `src/website-analysis/analysis-errors.ts`. Modify `src/website-analysis/index.ts`. Test `tests/unit/website-analysis.test.ts`. Do not modify `src/website-analysis/facts.ts`, `src/website-analysis/errors.ts`, crawler files, workflows, or migrations.
- Do not import `parse5`, the crawler, leads, config, database, or network modules from the new files. `analysis.ts` may import the `WebsiteFacts` type and `WebsiteAnalysisError` only.
- Do not reuse `collapseWhitespace` or the DQ-030 custom whitespace class. Approved text uses one `String.prototype.trim` call. Internal characters stay as they are.
- The implementation must not add Gemini, Groq, Workers AI, OpenRouter, AI SDKs, HTTP, DNS, provider or fallback routing, 50/day enforcement, usage accounting, provider or model metadata, latency or token tracking, D1, SQLite, migrations, repositories, persistence, a scheduler, GitHub Actions, qualification, lead scoring, contacts, outreach, retries, queues, or background processing.
- No `Date`, `Date.now`, `new Date`, `Math.random`, `process.env`, `fetch`, database handle, or provider client in the new files.
- Tests use `node:test` and `node:assert/strict`, imported from the public barrel `../../src/website-analysis`. `package.json` exposes `npm test` and `npm run typecheck` only. There is no single-file npm script.
- The targeted command mirrors `scripts/run-tests.cjs` for this file. Run it from the repository root. `.test-build/` is gitignored. This repo's shell is zsh, where `status` is read-only, so the command uses `exit_code`.

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/unit/website-analysis.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

- Final verification is `npm test`, `npm run typecheck`, `git diff --check`, and the targeted command. The pre-change suite has 421 passing tests. This plan adds 18. The full suite then has 439 passes, 0 fails, and 0 skips.
- At integration time, after the implementation is ready and still before the Analyst's APPROVED commit, synchronize `docs/PLAN.md` and `docs/BACKLOG.md` as Task 3 specifies. DQ-031 becomes Completed only then. Phase 3 stays Current. DQ-032–039 stay Planned. Do not claim that an AI provider, adapter, or website analysis exists. The next planned step becomes the first actual provider adapter, and that adapter stays unimplemented. Do not edit those living docs during this planning task.

## Review Focus

These five cases are the ones a happy-path assertion would miss. Each one is owned by the named test.

1. **Identity mismatch precedence when identity types are valid.** A numeric `evidenceId`, string `leadId`, and numeric `leadVersion` that do not strictly equal the facts throw `ANALYSIS_IDENTITY_MISMATCH` even when an extra own key, an overlong summary, and a malformed finding are also present. Test: `rejects a typed identity mismatch before other schema defects` in Task 1.
2. **Inherited properties do not satisfy exact own-key validation.** An inherited required key is missing. An inherited extra key is not an extra own key. A shadowed own value wins over the prototype. Test: `rejects inherited required keys and ignores inherited extra keys` in Task 1, extended with finding keys in Task 2.
3. **Exact boundary lengths after trim.** Trim first, then measure JavaScript `string.length` in UTF-16 code units. 800 and 500 are valid. 801 and 501 are invalid. Surrounding whitespace does not count. A supplementary-plane character counts as two code units. Test: `accepts exact text bounds after trim and rejects one code unit over` in Task 2.
4. **Per-category count limit is independent of the total limit.** Three findings in one category are valid. Four findings in one category are invalid when the total is still below 8. Test: `rejects four findings in one category while the total stays within eight` in Task 2.
5. **Immutability without mutating the untrusted candidate.** The returned root, findings array, and every finding are frozen new objects. `facts`, the candidate root, the candidate findings array, and the candidate finding objects stay unchanged, including untrimmed source text. Test: `freezes the analysis and leaves facts and the candidate unchanged` in Task 3.

## Locked algorithms

Paste these into the task that implements them. Do not replace them with a schema library or a full validator body from another task.

### Plain object and own keys

```ts
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  if (names.length !== keys.length) {
    return false;
  }
  return keys.every((key) => Object.hasOwn(value, key));
}
```

`Object.hasOwn` is the presence test. A key found only on the prototype is absent. A key found only on the prototype is not an extra own key. `Object.getOwnPropertyNames` plus a symbol check makes a non-enumerable own name or an own symbol fail the exact set. `Object.keys` is not sufficient because it skips non-enumerable own names.

Read an own value with `Object.hasOwn` first. Do not use `value[key]` before that check, or an inherited value will be treated as present.

### Identity precedence

Apply this order. Later failures must not change an earlier code.

1. If `isPlainObject(candidate)` is false, throw `INVALID_ANALYSIS`. Do this for `null`, arrays, functions, and primitives. An array stays `INVALID_ANALYSIS` even when identity fields were assigned onto it. Do not compare those fields.
2. Read `evidenceId`, `leadId`, and `leadVersion` only when each name is an own property. A missing own property, including one that exists only on the prototype, is `INVALID_ANALYSIS`.
3. Require the primitive types `number`, `string`, and `number` in that field order. Any other type, including a numeric string, a boxed `String`, or a boxed `Number`, is `INVALID_ANALYSIS`. Do not coerce.
4. When all three own values have those types, compare them with `!==` to `facts.evidenceId`, `facts.leadId`, and `facts.leadVersion`. Any inequality throws `ANALYSIS_IDENTITY_MISMATCH` immediately. Do not inspect summary length, extra keys, or findings before throwing. Do not replace this code with `INVALID_ANALYSIS`.
5. Only after the identity matches, apply the remaining root rules: exact own keys, summary type and bounds, and `Array.isArray(findings)`. Those failures are `INVALID_ANALYSIS`.

`NaN` has type `number` and `NaN !== facts.evidenceId`, so it is an identity mismatch. Do not add a special numeric check.

### Trim, then length

For `summary`, `observation`, `evidence`, and `recommendation`:

1. Reject a value whose `typeof` is not `string` with `INVALID_ANALYSIS`.
2. Call `value.trim()` once. That is `String.prototype.trim`. Do not collapse internal whitespace and do not call the DQ-030 whitespace helpers.
3. Reject a trimmed length of 0 with `INVALID_ANALYSIS`.
4. Reject a trimmed length above the field maximum with `INVALID_ANALYSIS`. Do not slice the string.
5. Store the trimmed string in the new result. Leave the candidate string unchanged.

Inclusive maxima: summary 800, observation 500, evidence 800, recommendation 500. Length is `string.length`, so one emoji such as `😀` contributes 2.

### Finding order and category counts

After the root and summary are valid:

1. If `findings.length > 8`, throw `INVALID_ANALYSIS` before accepting any finding.
2. Walk the array from index 0 upward. Do not sort it and do not remove duplicates.
3. Each element must be a plain object with exact own keys `category`, `severity`, `observation`, `evidence`, and `recommendation`.
4. `category` and `severity` must be primitive strings equal to the approved spellings. `SEO`, `Design`, and `High` are invalid. Do not case-fold.
5. Trim and bound the three text fields.
6. Count the accepted category. If that count becomes greater than 3, throw `INVALID_ANALYSIS`.
7. Push a new object, in this same walk order, into a new findings array.

Task 1 has a temporary gate after step 5 of identity precedence: a findings array whose length is not 0 throws `INVALID_ANALYSIS`. Task 2 deletes that gate and uses this section instead. An empty array remains valid.

### Freeze order

Construct new objects. Then freeze in this order:

1. `Object.freeze` each new finding object.
2. `Object.freeze` the new findings array.
3. `Object.freeze` the new root.

Write `facts.evidenceId`, `facts.leadId`, and `facts.leadVersion` into that new root after the strict match. Do not copy any other `WebsiteFacts` field. Do not freeze or assign to `facts`, `candidate`, `candidate.findings`, or any candidate finding.

## Task 1: Root and identity validation

**Files:**
- Create: `src/website-analysis/analysis-errors.ts`
- Create: `src/website-analysis/analysis.ts`
- Modify: `src/website-analysis/index.ts`
- Test: `tests/unit/website-analysis.test.ts`

**Interfaces:**
- Consumes: `WebsiteFacts` from `src/website-analysis/facts.ts`. The identity fields are `evidenceId: number`, `leadId: string`, and `leadVersion: number`.
- Produces: `WEBSITE_ANALYSIS_ERROR_CODES`, `WebsiteAnalysisError`, `WebsiteAnalysisErrorCode`, `validateWebsiteAnalysis(facts: WebsiteFacts, candidate: unknown): WebsiteAnalysis`, and the types `WebsiteAnalysisCategory`, `WebsiteAnalysisSeverity`, `WebsiteAnalysisFinding`, and `WebsiteAnalysis`. Task 1's success path returns zero findings. Non-empty findings throw `INVALID_ANALYSIS` until Task 2.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/website-analysis.test.ts` with this contents:

```ts
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
```

- [ ] **Step 2: Run the targeted command to verify it fails**

Run the targeted command from the repository root.

Expected: exit status non-zero. `node --test` does not run. stderr contains `error TS2305` because `../../src/website-analysis` has no exported member `validateWebsiteAnalysis`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/website-analysis/analysis-errors.ts`:

```ts
export const WEBSITE_ANALYSIS_ERROR_CODES = Object.freeze([
  "INVALID_ANALYSIS",
  "ANALYSIS_IDENTITY_MISMATCH",
] as const);

export type WebsiteAnalysisErrorCode =
  (typeof WEBSITE_ANALYSIS_ERROR_CODES)[number];

const messages: Readonly<Record<WebsiteAnalysisErrorCode, string>> = {
  INVALID_ANALYSIS: "Website analysis is invalid.",
  ANALYSIS_IDENTITY_MISMATCH:
    "Website analysis identity does not match the website facts.",
};

export class WebsiteAnalysisError extends Error {
  readonly name = "WebsiteAnalysisError";

  constructor(readonly code: WebsiteAnalysisErrorCode) {
    super(messages[code]);
  }
}
```

Replace `src/website-analysis/index.ts` with:

```ts
export { WEBSITE_FACTS_ERROR_CODES, WebsiteFactsError } from "./errors";
export type { WebsiteFactsErrorCode } from "./errors";
export { extractWebsiteFacts } from "./facts";
export type { WebsiteFacts } from "./facts";
export {
  WEBSITE_ANALYSIS_ERROR_CODES,
  WebsiteAnalysisError,
} from "./analysis-errors";
export type { WebsiteAnalysisErrorCode } from "./analysis-errors";
export { validateWebsiteAnalysis } from "./analysis";
export type {
  WebsiteAnalysis,
  WebsiteAnalysisCategory,
  WebsiteAnalysisFinding,
  WebsiteAnalysisSeverity,
} from "./analysis";
```

Create `src/website-analysis/analysis.ts` with the exported types from the spec and `validateWebsiteAnalysis`. Use the plain-object, own-key, identity-precedence, and trim-then-length algorithms. Root keys are `evidenceId`, `leadId`, `leadVersion`, `summary`, and `findings`. Summary maximum is 800. Store `facts.evidenceId`, `facts.leadId`, and `facts.leadVersion` in a new object.

Run identity precedence steps 1–4 before reading `summary` or `findings`. A typed mismatch throws `ANALYSIS_IDENTITY_MISMATCH` even when the summary is overlong, an extra own key is present, or a finding is malformed. Only after the three identity values match: require the exact root own keys, validate the summary, then require `Array.isArray(findings)`. If that array's length is not 0, throw `INVALID_ANALYSIS`. This gate is removed in Task 2. Return the new object with `findings: []` without freezing yet.

Do not validate finding elements in this task. Do not add a second exported function.

- [ ] **Step 4: Run the targeted command to verify it passes**

Run the targeted command from the repository root.

Expected: exit status 0, `# tests 8`, `# pass 8`, and `# fail 0`.

- [ ] **Step 5: Commit checkpoint**

Do not run this during Builder execution. Leave the files unstaged.

```bash
git add src/website-analysis/analysis-errors.ts src/website-analysis/analysis.ts src/website-analysis/index.ts tests/unit/website-analysis.test.ts
git commit -m "feat: validate website analysis identity"
```

Checkpoint paths, and no others: `src/website-analysis/analysis-errors.ts`, `src/website-analysis/analysis.ts`, `src/website-analysis/index.ts`, `tests/unit/website-analysis.test.ts`.

## Task 2: Finding validation and bounds

**Files:**
- Modify: `src/website-analysis/analysis.ts`
- Modify: `tests/unit/website-analysis.test.ts`
- Test: `tests/unit/website-analysis.test.ts`

**Interfaces:**
- Consumes: `validateWebsiteAnalysis(facts: WebsiteFacts, candidate: unknown): WebsiteAnalysis` and `WebsiteAnalysisError` from Task 1. Task 1 still rejects every non-empty findings array with `INVALID_ANALYSIS`.
- Produces: the same function, now accepting 0..8 valid findings in submitted order. Each returned finding has the five approved fields only. No new export is added.

- [ ] **Step 1: Extend the inherited-key test and append the finding tests**

Replace the whole `rejects inherited required keys and ignores inherited extra keys` test with:

```ts
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
```

Append these tests after the existing tests. Keep the helpers.

```ts
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
  for (const severity of ["High", "LOW", "critical"]) {
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
```

- [ ] **Step 2: Run the targeted command to verify it fails**

Run the targeted command from the repository root.

Expected: exit status 1. `node --test` runs. The output contains `not ok` for `rejects inherited required keys and ignores inherited extra keys`, `accepts every category and severity`, `accepts exact text bounds after trim and rejects one code unit over`, `preserves submitted finding order and duplicate findings`, and `rejects four findings in one category while the total stays within eight`. Those fail because Task 1 throws `INVALID_ANALYSIS` for every non-empty findings array. Rejection-only tests may already pass for that same reason. `# pass` is not 16.

- [ ] **Step 3: Write the minimal finding validation**

In `validateWebsiteAnalysis`, delete the Task 1 gate that rejects every non-empty findings array. Keep the identity-precedence order. After summary validation and the `Array.isArray(findings)` check, apply the finding-order and category-count algorithm and the trim-then-length algorithm.

Build a new array. Each element is a new object with the five validated fields and the trimmed text. Do not copy `score`, `opportunities`, or any other own or inherited key. Do not sort. Do not drop a duplicate. Do not freeze yet.

An empty array still returns `findings: []`. A length above 8 throws `INVALID_ANALYSIS` before a finding is accepted. The fourth finding in one category throws `INVALID_ANALYSIS` even when the length is 4, 5, 6, 7, or 8.

- [ ] **Step 4: Run the targeted command to verify it passes**

Run the targeted command from the repository root.

Expected: exit status 0, `# tests 16`, `# pass 16`, and `# fail 0`.

- [ ] **Step 5: Commit checkpoint**

Do not run this during Builder execution. Leave the files unstaged.

```bash
git add src/website-analysis/analysis.ts tests/unit/website-analysis.test.ts
git commit -m "feat: validate website analysis findings"
```

Checkpoint paths, and no others: `src/website-analysis/analysis.ts` and `tests/unit/website-analysis.test.ts`.

## Task 3: Freeze, non-mutation, and integration docs

**Files:**
- Modify: `src/website-analysis/analysis.ts`
- Modify: `tests/unit/website-analysis.test.ts`
- Modify: `docs/PLAN.md`
- Modify: `docs/BACKLOG.md`
- Test: `tests/unit/website-analysis.test.ts`

**Interfaces:**
- Consumes: `validateWebsiteAnalysis(facts: WebsiteFacts, candidate: unknown): WebsiteAnalysis` from Task 2, including ordered findings that are not yet frozen.
- Produces: the same function, returning a result whose finding objects, findings array, and root are frozen. The public signatures do not change.

- [ ] **Step 1: Write the failing immutability and determinism tests**

Append both tests to `tests/unit/website-analysis.test.ts`.

```ts
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
```

- [ ] **Step 2: Run the targeted command to verify it fails**

Run the targeted command from the repository root.

Expected: exit status 1. The output contains `not ok` for `freezes the analysis and leaves facts and the candidate unchanged` because `Object.isFrozen(first)` is false. The earlier 16 tests still pass. `validation does not call fetch or read the clock` may already pass, because Task 2 performs no fetch and reads no clock.

- [ ] **Step 3: Freeze the constructed result**

Apply the freeze-order algorithm to the object Task 2 already builds. Freeze each new finding, then the new findings array, then the root. Do not freeze an empty array differently: freeze it too. Do not call `Object.freeze` on `facts`, `candidate`, or objects taken from the candidate.

- [ ] **Step 4: Run the targeted command to verify it passes**

Run the targeted command from the repository root.

Expected: exit status 0, `# tests 18`, `# pass 18`, and `# fail 0`.

- [ ] **Step 5: Review the new source for forbidden scope**

Run this from the repository root:

```bash
git grep -n -E 'fetch\(|Date\.now|new Date|Math\.random|process\.env|gemini|groq|openrouter|workers ai|@cf/|zod|ajv|joi|WebsiteAnalysisInput|sqlite|d1' -i -- src/website-analysis/analysis.ts src/website-analysis/analysis-errors.ts src/website-analysis/index.ts
```

Expected: no output. `git grep` exits 1 when nothing matches. That exit status is the required review result. Do not add a match to change the exit status. Provider names may remain in this plan and in the spec. They must not appear in the three source files above.

- [ ] **Step 6: Synchronize the living docs**

Do this only after Step 4 passes. DQ-031 is ready to integrate and is still not an AI call.

In `docs/PLAN.md`:

- Keep `## Phase 3 — Website Analysis` at **Status: Current**. Do not mark Phase 3 complete.
- Replace `DQ-030 is completed. DQ-031–039 remain planned.` with `DQ-030 and DQ-031 are completed. DQ-032–039 remain planned.`
- Keep the sentence that no AI website analysis exists yet.
- Under the DQ-030 section, add `### DQ-031 — Provider-Neutral Website Analysis` with **Status: Completed**. State that `validateWebsiteAnalysis` checks one untrusted candidate against one `WebsiteFacts` value and returns one frozen `WebsiteAnalysis`, or throws `WebsiteAnalysisError`. State that it performs no AI request, provider call, persistence, daily budget, fallback routing, qualification, contact discovery, or outreach.
- In Current Position, change the Phase 3 line so DQ-030 and DQ-031 are completed and DQ-032–039 remain planned. Add `DQ-031 — Provider-Neutral Website Analysis: Completed.`
- In Next Planned Step, say DQ-031 is completed and the next planned step is the first actual provider adapter. Say that adapter is not implemented. Keep the approved future free-only order as future documentation. Do not describe a router, a budget enforcer, or a completed AI analysis. Keep the existing DQ-020–025, discovery SQLite, and scheduled-crawl sentences.

In `docs/BACKLOG.md`:

- In Current Status, record DQ-031 completed, DQ-032–039 planned, Phase 3 current, and no AI website analysis yet. The next planned step is the unimplemented first provider adapter.
- Replace `### DQ-031–039 — Website Analysis` with `### DQ-031 — Provider-Neutral Website Analysis` at **Status: Completed**, using the same validator boundary as the plan section, and `### DQ-032–039 — Website Analysis` at **Status: Planned**.
- Keep the later-analysis wording on DQ-032–039. Do not invent a separate DQ-032 title.

- [ ] **Step 7: Run final verification**

Run `npm test` from the repository root.

Expected: exit status 0, `# tests 439`, `# pass 439`, `# fail 0`, and `# skipped 0`.

Run `npm run typecheck`.

Expected: exit status 0.

Run the targeted command.

Expected: exit status 0, `# tests 18`, `# pass 18`, and `# fail 0`.

Run `git diff --check`.

Expected: no whitespace errors.

- [ ] **Step 8: Commit checkpoint**

Do not run this during Builder execution. Leave every implementation and documentation change unstaged and uncommitted.

```bash
git add src/website-analysis/analysis.ts tests/unit/website-analysis.test.ts docs/PLAN.md docs/BACKLOG.md
git commit -m "feat: freeze provider-neutral website analysis"
```

Expected unstaged paths, and no others: `docs/BACKLOG.md`, `docs/PLAN.md`, `src/website-analysis/analysis-errors.ts`, `src/website-analysis/analysis.ts`, `src/website-analysis/index.ts`, and `tests/unit/website-analysis.test.ts`. `package.json` and `package-lock.json` stay unchanged. Do not push.
