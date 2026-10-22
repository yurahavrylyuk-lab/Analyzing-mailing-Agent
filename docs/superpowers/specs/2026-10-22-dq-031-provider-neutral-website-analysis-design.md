# DQ-031 — Provider-Neutral Website Analysis Contract

## Status

```text
design, human-approved, not implemented
```

## Context

DQ-030 now transforms one persisted fetched crawl evidence record into one immutable deterministic `WebsiteFacts` value.

`WebsiteFacts` includes:

- exact evidence/lead identity
- metadata
- structural HTML facts
- link counts
- cleaned visible page text capped at 12,000 UTF-16 code units

DQ-031 defines the semantic contract that future AI providers must satisfy.

DQ-031 itself performs no AI request.

Future Gemini, Groq, Cloudflare Workers AI, and OpenRouter adapters will produce untrusted candidate output and pass it through DQ-031 validation.

The contract must remain provider-neutral so all future providers produce the same internal semantic shape.

## Goal

Given:

```ts
WebsiteFacts
```

and one untrusted candidate value:

```ts
unknown
```

validate and return one immutable provider-neutral:

```ts
WebsiteAnalysis
```

The analysis contains:

- exact evidence/lead identity
- one bounded summary
- zero to eight structured findings
- required evidence for every finding
- one recommendation per finding

DQ-031 does not decide whether the business should be contacted.

## Approved architecture

Flow:

```text
DQ-030 WebsiteFacts
        +
untrusted future AI candidate
        ↓
validateWebsiteAnalysis()
        ↓
frozen provider-neutral WebsiteAnalysis
```

DQ-031 owns semantic validation only.

Provider transport, prompts, API credentials, rate limits, retries, fallback logic, usage tracking, persistence, daily budgets, qualification, contacts, and outreach remain outside this task.

## Module boundary

Extend the existing:

```text
src/website-analysis/
```

module.

Approved structure:

```text
src/website-analysis/
  facts.ts              # existing DQ-030
  errors.ts             # existing DQ-030 facts errors
  analysis.ts           # DQ-031 contract + validator
  analysis-errors.ts    # DQ-031 validation errors
  index.ts              # public exports
```

Tests later:

```text
tests/unit/website-analysis.test.ts
```

Do not create a parallel AI package in DQ-031.

Do not add provider-specific files.

## Public semantic types

Define provider-neutral category:

```ts
type WebsiteAnalysisCategory =
  | "design"
  | "usability"
  | "seo"
  | "accessibility"
  | "conversion";
```

Define severity:

```ts
type WebsiteAnalysisSeverity =
  | "low"
  | "medium"
  | "high";
```

Define one finding:

```ts
type WebsiteAnalysisFinding = Readonly<{
  category: WebsiteAnalysisCategory;
  severity: WebsiteAnalysisSeverity;
  observation: string;
  evidence: string;
  recommendation: string;
}>;
```

Define the semantic result:

```ts
type WebsiteAnalysis = Readonly<{
  evidenceId: number;
  leadId: string;
  leadVersion: number;
  summary: string;
  findings: readonly WebsiteAnalysisFinding[];
}>;
```

Exact TypeScript declaration style may follow repository conventions, but these semantics are fixed.

## Public validator

Approved public entry point:

```ts
validateWebsiteAnalysis(
  facts: WebsiteFacts,
  candidate: unknown
): WebsiteAnalysis
```

DQ-031 reuses `WebsiteFacts` directly.

Do NOT create a duplicate `WebsiteAnalysisInput` DTO containing the same DQ-030 data.

Future provider adapters may serialize selected `WebsiteFacts` fields into prompts, but DQ-031 itself receives the complete `WebsiteFacts` value.

## Traceability

The validated semantic result must carry:

```text
evidenceId
leadId
leadVersion
```

These values must exactly match the supplied `WebsiteFacts`.

This allows later persistence and qualification to identify the exact crawl evidence and lead snapshot the analysis refers to.

Provider execution metadata is NOT part of this semantic contract.

Do NOT include:

```text
provider
model
fallbackDepth
latency
token usage
request id
```

in `WebsiteAnalysis`.

Those belong to a future execution/provenance envelope.

## Finding categories

The approved categories are exactly:

```text
design
usability
seo
accessibility
conversion
```

DQ-031 accepts no additional category strings.

`category` and `severity` must be primitive strings and must match these approved strings exactly, including case. `SEO`, `Design`, `High`, or any other spelling is unknown and is `INVALID_ANALYSIS`.

### Meaning

`design`
- presentation/modernity observations that can be reasonably grounded in the available facts/text
- no image rendering or screenshot inference is implied

`usability`
- navigation/content structure/forms/mobile-readiness signals and similar usability observations

`seo`
- title/meta/headings/language/content-structure/discoverability observations

`accessibility`
- image alt, language, heading, structural accessibility-related observations supported by input

`conversion`
- service clarity, CTA/contact/booking/value-proposition observations supported by page facts/text

These are analysis categories only.

They are not qualification criteria.

## Evidence requirement

Every finding must contain nonempty:

```text
evidence
```

A finding without evidence is invalid.

The contract intentionally does not allow unsupported model assertions.

The `evidence` string should explain which available `WebsiteFacts` field(s) or visible-page content support the observation.

DQ-031 validates shape/bounds, not truthfulness or semantic quality.

Future prompt/provider work should instruct models to ground evidence in DQ-030 facts or cleaned visible text.

## No separate opportunities list

Do NOT add:

```ts
opportunities: string[]
```

or an equivalent top-level duplicate list.

Each finding already contains:

```text
observation
evidence
recommendation
```

This is the only improvement-opportunity representation in DQ-031.

## No overall score

Do NOT add:

```text
score
rating
qualityScore
leadScore
contactScore
```

or equivalent.

DQ-031 does not qualify or rank a lead.

## Strict validation

Use manual TypeScript validation.

Do NOT add:

- Zod
- Joi
- Ajv
- JSON Schema runtime dependencies
- another schema-validation package

No new npm dependency is required for DQ-031.

## Exact root keys

The untrusted candidate root object must contain exactly:

```text
evidenceId
leadId
leadVersion
summary
findings
```

Missing root keys are invalid.

Unexpected root keys are invalid.

No coercion is permitted.

Examples:

```text
"12" → number
```

must NOT be coerced.

A root value counts as an object only when it is a non-null object and not an array. `null`, arrays, and primitive values are not root objects and are `INVALID_ANALYSIS`.

The exact key set is the object's own property names. A required key that exists only as an inherited property is missing. An inherited property is not an extra key.

## Exact finding keys

Each finding must contain exactly:

```text
category
severity
observation
evidence
recommendation
```

Missing finding keys are invalid.

Unexpected finding keys are invalid.

A finding counts as an object only when it is a non-null object and not an array. The exact finding key set is that object's own property names, using the same own-versus-inherited rule as the root.

## Text normalization

For validated text fields:

```text
summary
observation
evidence
recommendation
```

trim leading/trailing whitespace before checking final length and before placing the value into the returned `WebsiteAnalysis`.

Trim means `String.prototype.trim` only. Internal whitespace is preserved.

Do not otherwise rewrite or summarize the model content.

Whitespace-only values are invalid.

Do not silently truncate overlong values.

Overlong values are invalid.

## Bounds

Approved summary bound:

```text
1..800 characters
```

Approved finding bounds:

```text
observation:    1..500 characters
evidence:       1..800 characters
recommendation: 1..500 characters
```

Measure these bounds with JavaScript `string.length` after trimming. `string.length` counts UTF-16 code units. That is the deterministic string-length rule already used by DQ-030 for `visibleText`. No alternate length rule applies.

These bounds are inclusive. A trimmed summary of length 800 is valid. A trimmed summary of length 801 is invalid. The same inclusive reading applies to each finding bound.

Do not add token-based limits in DQ-031.

## Findings bounds

Approved:

```text
0..8 findings total
```

Zero findings is valid when the summary is valid.

Maximum:

```text
8 total
```

Per category:

```text
max 3 findings
```

Examples:

```text
3 seo → valid
4 seo → invalid
```

even if the total remains <= 8.

## Duplicate findings

Do not deduplicate findings in DQ-031.

If two otherwise valid findings contain the same or similar content, they remain valid.

Preserve the submitted finding order. Do not sort findings.

Deduplication or qualitative quality scoring is later work.

DQ-031 validates the semantic contract rather than judging analysis quality.

## Identity validation

Candidate:

```text
evidenceId
leadId
leadVersion
```

must exactly match:

```text
facts.evidenceId
facts.leadId
facts.leadVersion
```

Mismatch must not be classified as generic schema invalidity.

Use the dedicated analysis identity error.

Before any identity comparison, a root that is not a non-null, non-array object is `INVALID_ANALYSIS`. An array is not a root object, even if identity fields have been assigned on it.

Identity comparison runs only when all three identity fields are present as own properties and have the required primitive types: `evidenceId` is a `number`, `leadId` is a `string`, and `leadVersion` is a `number`. A missing identity key, an inherited-only identity key, or a wrong identity type is `INVALID_ANALYSIS`. No numeric or string coercion is applied.

When all three identity fields have those types, compare them with strict equality to `facts.evidenceId`, `facts.leadId`, and `facts.leadVersion`. If any field is not strictly equal, throw `ANALYSIS_IDENTITY_MISMATCH`. That dedicated error applies even when the candidate also has extra keys, an invalid summary, or invalid findings. Do not replace it with `INVALID_ANALYSIS`.

When the three identity fields match and any other rule fails, throw `INVALID_ANALYSIS`.

Among causes that are all `INVALID_ANALYSIS`, the domain-error category is what must stay stable. The validator does not return a partial result in either category.

## Error domain

Create:

```text
WebsiteAnalysisError
```

with allowlisted error codes:

```text
INVALID_ANALYSIS
ANALYSIS_IDENTITY_MISMATCH
```

Follow existing project error conventions.

### `INVALID_ANALYSIS`

Use for semantic/schema violations such as:

- candidate is not an object
- missing root key
- extra root key
- wrong root field type
- `findings` is not an array
- finding is not an object
- missing finding key
- extra finding key
- unknown category
- unknown severity
- empty/whitespace-only text
- text above bound
- more than 8 findings
- more than 3 findings in one category

### `ANALYSIS_IDENTITY_MISMATCH`

Use only when an otherwise parseable candidate identity does not exactly match supplied `WebsiteFacts`.

Otherwise parseable means the three identity fields are present as own properties with the primitive types required above.

Do not include raw model/provider response bodies in error messages.

## Atomic validation behavior

`validateWebsiteAnalysis(...)` must either:

1. return one fully valid immutable `WebsiteAnalysis`; or
2. throw `WebsiteAnalysisError`.

No partial analysis result.

No partially accepted findings.

No warning result.

No best-effort acceptance.

## Immutability

The validated return value must be deeply immutable for its actual shape.

At minimum:

- freeze each returned finding
- freeze the returned `findings` array
- freeze the returned `WebsiteAnalysis` root

There are no deeper nested mutable structures in DQ-031.

The function must not mutate:

```text
facts
candidate
candidate.findings
candidate finding objects
```

The validator must construct its own validated result.

## Determinism

For the same:

```text
WebsiteFacts
candidate
```

input pair, validation must produce equivalent output or the same domain-error category.

DQ-031 must not depend on:

- clock
- randomness
- environment
- network
- database
- provider state

## Provider neutrality

DQ-031 runtime code must not reference provider-specific APIs or SDKs.

No runtime dependency on:

- Gemini
- Groq
- Cloudflare Workers AI
- OpenRouter

Provider names may appear only in design documentation explaining future architecture.

The semantic contract must remain usable by any future provider.

## Testing strategy

Implementation tests later should cover four groups.

### 1. Happy-path contract

Cover:

- valid complete analysis
- all 5 categories accepted
- all 3 severities accepted
- zero findings accepted
- 8 total findings accepted
- exactly 3 findings in one category accepted
- trimmed returned strings
- exact identity retained

### 2. Strict rejection

Cover:

- non-object root
- missing root keys
- extra root keys
- wrong root primitive types
- non-array `findings`
- non-object finding
- missing finding key
- extra finding key
- unknown category
- unknown severity
- empty summary
- whitespace-only summary
- empty/whitespace observation
- empty/whitespace evidence
- empty/whitespace recommendation
- summary >800
- observation >500
- evidence >800
- recommendation >500
- >8 total findings
- >3 findings in one category
- identity mismatch for `evidenceId`
- identity mismatch for `leadId`
- identity mismatch for `leadVersion`

### 3. Immutability / non-mutation

Cover:

- returned root frozen
- returned findings array frozen
- every returned finding frozen
- supplied `WebsiteFacts` remains unchanged
- supplied candidate object remains unchanged
- supplied candidate findings remain unchanged

### 4. Scope/provider neutrality

Implementation review should verify:

- no network calls
- no provider SDK
- no provider-specific semantic fields
- no persistence
- no daily budget
- no fallback routing
- no qualification logic
- no contact logic
- no outreach logic

## Future provider architecture

DQ-031 intentionally prepares later work:

```text
WebsiteFacts
    ↓
future provider adapter
    ↓
unknown candidate
    ↓
validateWebsiteAnalysis()
    ↓
WebsiteAnalysis
```

Approved future free-only provider order remains:

```text
Gemini
→ Groq
→ Cloudflare Workers AI
→ OpenRouter
```

That routing is NOT implemented in DQ-031.

## Future AI input

The approved future AI input remains:

```text
deterministic WebsiteFacts
+
cleaned bounded visibleText
```

Raw HTML is not the AI-facing contract.

## Future AI daily budget

Approved future target remains:

```text
maximum 50 unique crawl evidence records
per Europe/Warsaw calendar day
```

Fallback requests for the same website do not consume additional website slots.

This is documented for compatibility only.

DQ-031 does NOT enforce the budget.

## Future provider-cost policy

Approved future policy remains:

```text
free-only
```

unless explicitly changed by a human later.

No paid fallback is part of DQ-031.

## Qualification boundary

DQ-031 may validate analysis such as:

```text
"The page has no clear primary CTA."
```

It must not represent or return:

```text
"This lead should be contacted."
```

Qualification belongs to Phase 4.

Website analysis cannot override suppression or future contact rules.

## Persistence boundary

DQ-031 does not persist `WebsiteAnalysis`.

No:

- database table
- D1 schema
- SQLite schema
- migration
- repository
- audit event

is added in this slice.

Persistence is later Phase 3 work.

## DQ-031 completion boundary

DQ-031 is complete when:

1. one untrusted candidate analysis can be strictly validated against one `WebsiteFacts`;
2. valid output becomes one deeply frozen provider-neutral `WebsiteAnalysis`;
3. invalid schema/content is rejected with `INVALID_ANALYSIS`;
4. identity mismatch is rejected with `ANALYSIS_IDENTITY_MISMATCH`;
5. all approved bounds are enforced;
6. no AI provider, network, persistence, budget, fallback, qualification, contacts, or outreach is implemented.
