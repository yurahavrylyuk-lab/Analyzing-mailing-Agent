# DQ-030 — Deterministic Website Facts

Status: design, human-approved, not implemented.

## Context

Phase 2 now produces persisted append-only crawl evidence containing fetched HTML or an allowlisted crawl failure.

Phase 3 begins by turning one successfully fetched evidence record into deterministic, objective website facts.

DQ-030 is intentionally offline and provider-independent.

It establishes the factual substrate that later AI analysis can consume.

It does NOT itself perform qualitative AI analysis.

## Goal

Given one persisted fetched `StoredSinglePageCrawlEvidence`, produce one immutable deterministic `WebsiteFacts` value containing:

- exact crawl/lead identity
- metadata
- structural HTML facts
- image accessibility facts
- form/link counts
- cleaned bounded visible page text

The same evidence input must always produce the same output.

## Non-goals

DQ-030 does NOT:

- perform any HTTP or DNS request
- refetch a website
- call Gemini
- call Groq
- call Cloudflare Workers AI
- call OpenRouter
- contain AI provider abstractions
- persist website analysis
- modify crawl evidence
- modify leads
- qualify a lead
- score commercial opportunity
- decide whether contact should occur
- discover contact information
- draft or send outreach
- add a CLI or scheduler
- read environment configuration
- depend on production D1 or SQLite

## Input

Public entry:

```ts
extractWebsiteFacts(
  evidence: StoredSinglePageCrawlEvidence
): WebsiteFacts
```

DQ-030 accepts persisted evidence because later website analysis must remain linked to the exact crawl attempt that supplied the HTML.

Only:

```text
outcome = fetched
```

is analyzable.

Failed evidence must be rejected with an allowlisted website-analysis domain error.

Suggested code:

```text
EVIDENCE_NOT_ANALYZABLE
```

DQ-030 must not create partial facts from failed crawl evidence.

## Output

Define an immutable shape equivalent to:

```ts
type WebsiteFacts = Readonly<{
  evidenceId: number;
  leadId: string;
  leadVersion: number;
  requestedUrl: string;
  finalUrl: string;

  title: string | null;
  metaDescription: string | null;
  documentLanguage: string | null;

  hasViewport: boolean;

  h1Count: number;
  headingCount: number;

  imageCount: number;
  imagesWithoutAlt: number;

  formCount: number;
  internalLinkCount: number;
  externalLinkCount: number;

  visibleText: string;
}>;
```

The exact TypeScript syntax may be refined during implementation, but these semantics are required.

## Metadata extraction

### Title

Read the page `<title>`.

Normalize by:

- extracting text
- trimming surrounding whitespace
- collapsing internal whitespace consistently

Absent or blank title becomes:

```ts
null
```

### Meta description

Read:

```html
<meta name="description" content="...">
```

The `name` comparison should behave consistently for ordinary HTML.

Normalize content through trimming and whitespace collapse.

Absent, missing-content, or blank content becomes:

```ts
null
```

### Document language

Read:

```html
<html lang="...">
```

Trim the value.

Blank or absent becomes:

```ts
null
```

DQ-030 does not attempt to validate language tags semantically.

### Viewport

`hasViewport` is true when the parsed document contains an applicable:

```html
<meta name="viewport" ...>
```

Otherwise false.

No quality judgment about the viewport content belongs in DQ-030.

## Heading facts

Count elements:

```text
h1
h2
h3
h4
h5
h6
```

`h1Count` counts only `<h1>` elements.

`headingCount` counts all six heading levels.

Invariant:

```text
h1Count <= headingCount
```

DQ-030 does not judge whether the heading structure is correct.

## Image facts

Count only:

```html
<img>
```

elements.

`imageCount` is the total number of `<img>` occurrences.

An image counts toward `imagesWithoutAlt` when:

- `alt` is absent
- `alt=""`
- `alt` contains only whitespace

A nonblank `alt` does not count as missing.

Invariant:

```text
imagesWithoutAlt <= imageCount
```

DQ-030 does not judge image relevance or visual quality.

## Forms

`formCount` is the number of `<form>` elements in the parsed document.

No inference is made about whether the forms are useful or valid.

## Link facts

Use `finalUrl` from the fetched crawl evidence as the base URL.

Inspect anchor elements with `href`.

Count only successfully resolved:

```text
http:
https:
```

URLs.

Ignore:

- fragment-only links
- `mailto:`
- `tel:`
- `javascript:`
- `data:`
- malformed/unresolvable URLs
- unsupported schemes

### Internal link

A counted URL is internal when its normalized hostname exactly matches the normalized hostname of `finalUrl`.

Subdomains are considered external in DQ-030.

Example:

```text
www.example.com
blog.example.com
```

are different hostnames and therefore external to one another.

### Duplicate links

Do NOT deduplicate links.

Every qualifying DOM occurrence is one structural page fact.

## Visible text

DQ-030 produces cleaned visible page text for later AI analysis.

It must derive that text only from the already stored HTML.

Exclude text contained within at least:

```text
script
style
noscript
template
svg
```

Text should otherwise preserve DOM/document order.

Normalize whitespace deterministically:

- collapse runs of whitespace
- remove meaningless surrounding whitespace
- produce stable output for the same input

### Hard cap

After cleaning and normalization, apply a hard cap of:

```text
12,000 characters
```

Truncation happens AFTER cleaning.

Raw HTML must never be used as the AI-facing content contract.

The later AI layer will receive:

```text
WebsiteFacts fields
+
WebsiteFacts.visibleText
```

rather than the full raw HTML document.

## Malformed HTML

Real-world HTML may be malformed.

DQ-030 should use a real HTML parser rather than regular expressions.

Recommended implementation dependency:

```text
parse5
```

No browser/runtime DOM is required.

Malformed but parseable HTML should still produce deterministic facts.

Optional malformed metadata should degrade to absent/null facts rather than failing the entire extraction.

Only invalid/non-analyzable crawl evidence should normally result in a DQ-030 domain error.

## Module boundary

Add the new Phase 3 module under:

```text
src/website-analysis/
```

Approved small structure:

```text
src/website-analysis/
  facts.ts
  errors.ts
  index.ts
```

Responsibilities:

### `facts.ts`

- `WebsiteFacts`
- deterministic extraction
- HTML traversal/parsing behavior

### `errors.ts`

- `WebsiteFactsError`
- allowlisted error code(s)

### `index.ts`

- public DQ-030 exports only

Do not add provider, persistence, routing, command, or configuration files in DQ-030.

## Dependency direction

Allowed:

```text
website-analysis
    ↓
crawler persisted evidence type
```

Forbidden:

```text
crawler
    ↓
website-analysis
```

The crawler remains unaware of Phase 3.

DQ-030 must also remain unaware of:

- D1
- SQLite
- GitHub Actions
- Gemini
- Groq
- Cloudflare Workers AI
- OpenRouter
- qualification
- contacts
- outreach

## Determinism

DQ-030 must have no dependency on:

- clocks
- randomness
- environment variables
- database state
- network state
- provider state

For the same persisted crawl evidence input:

```text
same input → same WebsiteFacts
```

## Immutability

Returned `WebsiteFacts` must be immutable/frozen consistently with existing project domain conventions.

DQ-030 must not mutate:

- the evidence object
- lead state
- HTML text
- any external state

## Required invariants

- `evidenceId` remains linked to the exact persisted crawl row
- `leadId` comes from the crawl evidence
- `leadVersion` comes from the crawl evidence
- requested/final URLs remain the crawl attempt snapshot
- all counters are non-negative integers
- `h1Count <= headingCount`
- `imagesWithoutAlt <= imageCount`
- `visibleText.length <= 12000`
- no network request is possible from DQ-030
- no AI request is possible from DQ-030

## Testing strategy

Add implementation tests later under:

```text
tests/unit/website-facts.test.ts
```

The implementation plan should require coverage for:

1. normal well-formed HTML
2. badly malformed but parseable HTML
3. title extraction
4. missing/blank title
5. meta description extraction
6. missing/blank description
7. HTML language extraction
8. viewport detection
9. multiple H1s
10. mixed H1–H6 headings
11. image count
12. missing `alt`
13. empty `alt`
14. whitespace-only `alt`
15. valid nonblank `alt`
16. form count
17. relative internal links
18. absolute internal links
19. external links
20. subdomain-as-external behavior
21. duplicate link occurrences
22. ignored fragment links
23. ignored `mailto:`
24. ignored `tel:`
25. ignored `javascript:`
26. ignored `data:`
27. malformed links
28. script text exclusion
29. style text exclusion
30. noscript text exclusion
31. template text exclusion
32. SVG text exclusion
33. whitespace normalization
34. Unicode visible text
35. exactly 12,000-character output
36. truncation above the cap
37. failed crawl evidence rejection
38. immutable/frozen result
39. repeated extraction produces equivalent result

All tests should be offline.

## Relationship to later AI analysis

DQ-030 is the factual input layer.

Approved broader Phase 3 direction:

```text
persisted fetched crawl evidence
        ↓
DQ-030 deterministic WebsiteFacts
        ↓
later provider-neutral AI analysis
        ↓
Gemini free tier
        ↓ fallback
Groq free tier
        ↓ fallback
Cloudflare Workers AI free allocation
        ↓ fallback
OpenRouter free models
        ↓
AI unavailable
```

The future AI system is free-only unless a human explicitly approves a different cost policy.

No paid fallback may be silently introduced.

## Future AI input

The approved future AI input is:

```text
deterministic WebsiteFacts
+
cleaned bounded visibleText
```

not raw HTML.

Future qualitative analysis categories are approved as:

```text
design
usability
seo
accessibility
conversion
```

The AI layer may produce observations and improvement opportunities.

It must not make the Phase 4 qualification/contact decision.

## Future daily AI budget

The approved future target is:

```text
maximum 50 unique crawl evidence records
per Europe/Warsaw calendar day
```

Fallback provider attempts for one evidence record do not consume additional website slots.

Example:

```text
Gemini fails
→ Groq fails
→ Cloudflare succeeds
```

still consumes:

```text
1 / 50 websites
```

not 3.

This budget is NOT implemented in DQ-030.

It is documented here only to ensure DQ-030 remains compatible with the approved later architecture.

## DQ-030 completion boundary

DQ-030 is complete when one persisted fetched crawl evidence record can be transformed deterministically into one validated immutable `WebsiteFacts` value with bounded cleaned visible text.

DQ-030 completion does NOT require:

- database persistence
- cloud execution
- AI integration
- provider fallback
- daily budget enforcement
- scheduling
- qualification
- contacts
- outreach

Those belong to later separately reviewed Phase 3 tasks.
