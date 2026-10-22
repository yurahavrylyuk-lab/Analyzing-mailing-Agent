# DQ-030 Deterministic Website Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one persisted fetched crawl-evidence record into one immutable `WebsiteFacts` value by reading the HTML already stored on that record.

**Architecture:** Add `src/website-analysis/` with a single public function, `extractWebsiteFacts`. It accepts only `outcome === "fetched"`, parses `bodyText` with `parse5`, and returns a frozen facts object. Failed evidence throws `WebsiteFactsError` and produces no facts object. The crawler never imports this module.

**Tech Stack:** TypeScript, Node.js, `node:test`, `node:assert/strict`, and `parse5` as the only new dependency.

**Spec:** `docs/superpowers/specs/2026-10-22-dq-030-deterministic-website-facts-design.md`

## Global Constraints

- Implement only the approved spec. Do not edit the spec. Do not start DQ-031. Do not add AI analysis, provider fallback, a daily budget, scheduling, qualification, scoring, contacts, or outreach.
- Create `feature/dq-030-deterministic-website-facts` from the approved plan commit on `design/dq-030-deterministic-website-facts`. Do not implement on `main` or on the design branch.
- Each task stays unstaged until Analyst records APPROVED for that task. The commit step below is the bookkeeping after that approval. Do not push, open a pull request, or merge in this plan.
- DQ-030 reads HTML already stored on a `StoredSinglePageCrawlEvidence` value. `StoredSinglePageCrawlEvidence` is `SinglePageCrawlEvidence & Readonly<{ id: number }>`, defined in `src/crawler/evidence-domain.ts`. A fetched record has `outcome: "fetched"`, `finalUrl`, and `bodyText`. A failed record has `outcome: "failed"` and `failure`, and it has no body.
- The only public function is `extractWebsiteFacts(evidence: StoredSinglePageCrawlEvidence): WebsiteFacts`. The only domain error is `WebsiteFactsError` with code `EVIDENCE_NOT_ANALYZABLE`. A failed record throws that error. Do not return a partial `WebsiteFacts` value.
- Import the evidence type with `import type`. Do not import `src/crawler/index.ts`, `fetchCrawlPage`, `normalizeSinglePageCrawlEvidence`, `normalizeWebsiteUrl`, or `normalizeNetworkUrl` from `src/website-analysis/`. Extraction must not throw a crawler or lead error.
- Do not modify `src/crawler/**`, `tests/unit/crawl-*.test.ts`, `tests/integration/**`, workflows, `wrangler.toml`, migrations, README, or the approved spec.
- Add `parse5` only, with `npm install parse5` from the repository root. That command updates `package.json` and `package-lock.json` together. `parse5` is not installed today, and neither is any other HTML parser. Do not add `jsdom`, a DOM emulator, `cheerio`, `node-html-parser`, `linkedom`, `@types/parse5`, a browser driver, or a network library.
- Call `parse` from `parse5` with no options, so scripting stays enabled and the default tree adapter is used. Do not call `parseFragment`. Do not parse tags with regular expressions. `text/html` and `application/xhtml+xml` both go through this one HTML parser.
- Walk element `childNodes` only. `parse5` stores a `template` element's innards on `content`, which is not part of the document tree. Do not read `template.content`.
- Match `src/crawler/errors.ts`: a frozen `as const` code array, a message record, and `readonly name = "WebsiteFactsError"` with `constructor(readonly code)`. The message is `Crawl evidence is not analyzable.` Do not set `cause`.
- Return `Object.freeze` of a plain `WebsiteFacts` object, the same shallow freeze used for crawl evidence. Do not mutate the evidence argument, its `bodyText`, or any other field.
- Counters are non-negative safe integers. `h1Count <= headingCount`. `imagesWithoutAlt <= imageCount`. `visibleText.length <= 12000`.
- No clocks, `Date.now`, `new Date`, `Math.random`, environment variables, database access, HTTP, DNS, or filesystem access in `src/website-analysis/`.
- Tests live in `tests/unit/website-facts.test.ts`. That is the spec path, and it matches this repo: unit tests are `tests/unit/*.test.ts` run by `node:test` after `tsc`. There is no `tests/crawler/` directory and no single-file npm script. `package.json` exposes `npm test` and `npm run typecheck` only.
- The targeted command below is the per-task proof. It mirrors `scripts/run-tests.cjs` for one compiled file. Run it from the repository root. `.test-build/` is gitignored; the command still deletes it.

```bash
npx tsc --noEmit false --outDir .test-build
status=$?
if [ "$status" -eq 0 ]; then
  node --test .test-build/tests/unit/website-facts.test.js
  status=$?
fi
rm -rf .test-build
exit "$status"
```

- Final verification uses the real scripts: `npm test`, `npm run typecheck`, `git diff --check`, and `git status --short`. Existing crawler tests keep passing. Production crawl behavior does not change.
- Do not introduce HTTP, DNS, browser automation, AI calls, Gemini, Groq, Workers AI, OpenRouter, D1, SQLite, persistence, a scheduler, GitHub Actions changes, qualification, scoring, contacts, outreach, retries, queues, or background processing. The DQ-020 crawler stays unchanged.

## Review Focus

These five edge classes are the ones a happy-path assertion would miss. Each one is owned by the named test.

1. **First applicable title and meta description.** A blank first title or a blank first description meta does not fall through to a later element, a title inside `template` is not the document title, and `name="DESCRIPTION"` still matches. Test: `selects the first title and the first meta description in document order` in Task 1.
2. **Relative links use the redirected final URL.** `/pricing` and `pricing` resolve against `finalUrl`, including its path. The original `requestedUrl` host is external. Test: `resolves relative links against the redirected finalUrl` in Task 3.
3. **Hostname equality is WHATWG `URL.hostname`.** Case and default ports stay internal. A non-default port stays internal because `hostname` omits the port. `www` versus the bare host, a subdomain, and a trailing dot stay external. Punycode and Unicode labels with the same hostname stay internal. Test: `compares hostnames with WHATWG hostname equality` in Task 3.
4. **Excluded nested text and malformed HTML.** Text inside `script`, `style`, `noscript`, `template`, and `svg` is absent, including nested markup. An unclosed `script` does not fail extraction, and the following source stays inside the script. Test: `drops nested text inside excluded elements and still reads malformed html` in Task 4.
5. **Unicode at the exact 12,000 code-unit boundary.** A 12,000-unit string that starts with `é` is kept. The 12,001st ASCII unit is removed. A supplementary-plane character that would be split at unit 12,000 is removed with its high surrogate, so the result does not end on U+D800–U+DBFF. Test: `caps visible text at the 12000 code-unit boundary` in Task 4.

## Locked algorithms

Inspection found no hostname-equality helper. `normalizeWebsiteUrl` returns a serialized URL and throws `InvalidLeadInputError` on values DQ-030 must ignore. `normalizeNetworkUrl` rejects ports and blocked hosts and strips a trailing DNS dot. Using either one would drop countable links or throw away the whole extraction. Compare `URL.hostname` only.

### Whitespace

JavaScript `\s` is not the contract. Use this exact set: U+0009, U+000A, U+000B, U+000C, U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.

Build a fresh regex on every call. A shared `/g` regex keeps `lastIndex` and will skip later matches.

```ts
function collapseWhitespace(value: string): string {
  const run = /[\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
  return value.replace(run, " ").replace(/^ | $/g, "");
}

function trimWhitespace(value: string): string {
  const edge = /[\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/;
  return value.replace(new RegExp(`^${edge.source}`), "").replace(new RegExp(`${edge.source}$`), "");
}
```

Title and meta description use `collapseWhitespace`. The empty string becomes `null`. `documentLanguage` uses `trimWhitespace` only, so an internal space or NBSP stays. The empty string becomes `null`. There is no BCP 47 check. Image `alt` is missing when the attribute is absent or `trimWhitespace` of its value is empty.

### Document order

`parse(bodyText)` returns the document. Walk `childNodes` in order. An element has a lowercase `tagName` and `attrs: { name: string; value: string }[]`. A text node has `nodeName === "#text"` and a string `value`. Ignore comments and the document type.

Element walk, preorder: visit the element, then visit each `childNodes` entry. Do not follow `template.content`. With scripting enabled, `noscript` contents are text, not elements.

### First applicable metadata

- `title`: the first `title` element in the element walk. Concatenate its descendant `#text` values in tree order, including text that looks like tags, because a title is RCDATA. Then `collapseWhitespace`. No `title` element, or a collapsed empty string, is `null`. Do not read a later `title`.
- `metaDescription`: the first `meta` element that has an attribute whose `name` is `name` and whose `value.toLowerCase()` is `"description"`. Read the first attribute whose `name` is `content`. A missing `content` attribute, or a collapsed empty string, is `null`. Do not read a later description meta. `toLowerCase()` is the match; do not locale-compare.
- `documentLanguage`: the first `html` element's `lang` attribute, passed through `trimWhitespace`. A missing attribute or empty trim is `null`. `lang` on `body` is not the document language. Preserve the trimmed casing.
- `hasViewport`: `true` when any `meta` in the element walk has a `name` attribute whose `value.toLowerCase()` is `"viewport"`. Empty content still counts. Two viewport metas are still `true`. `http-equiv="viewport"` does not count. Do not judge the content.

### Links

For each `a` element in the element walk that has an `href` attribute, in that order:

1. Let `raw` be the attribute value. Let `trimmed` be `trimWhitespace(raw)`.
2. If `trimmed.startsWith("#")`, ignore the anchor. This is a fragment-only href. A resolved URL that merely contains a hash is still eligible.
3. Otherwise resolve `new URL(raw, evidence.finalUrl)`. On `TypeError`, ignore the anchor.
4. If `resolved.protocol` is not `"http:"` and not `"https:"`, ignore the anchor. This drops `mailto:`, `tel:`, `javascript:`, `data:`, `ftp:`, and every other scheme.
5. Compare `new URL(evidence.finalUrl).hostname === resolved.hostname`. Equal hostnames are internal. Everything else countable is external. Do not compare `URL.host`, `URL.origin`, or the path. Do not deduplicate. An `a` without `href` is not a candidate. An empty or whitespace-only href is not fragment-only; `new URL` resolves it to `finalUrl`, so it is internal when `finalUrl` is `http:` or `https:`.
6. `www.example.com` and `example.com` differ. `blog.example.com` and `www.example.com` differ. `www.example.com.` keeps the trailing dot and differs from `www.example.com`. `https://WWW.EXAMPLE.COM` and `https://www.example.com:443` and `http://www.example.com:80` and `https://www.example.com:8443` all have hostname `www.example.com`. `https://bücher.example` and `https://xn--bcher-kva.example` both have hostname `xn--bcher-kva.example`.

`finalUrl` is the base, not `requestedUrl`. A protocol-relative href inherits the base protocol.

### Excluded visible text

Walk `childNodes` in document order. When the element tag is `script`, `style`, `noscript`, `template`, or `svg`, do not visit its children and do not read `template.content`. Otherwise, for a `#text` node, append `value` with no added separator. Concatenate the kept chunks, then `collapseWhitespace` once. Title text is kept, because `title` is not an excluded tag. Do not insert breaks for `p`, `div`, or `br`.

`visibleText` is that collapsed string after the cap below. Raw `bodyText` is never copied into `visibleText`.

### Cap

`visibleText.length` is JavaScript UTF-16 length, applied after exclusion and collapse.

```ts
const VISIBLE_TEXT_CAP = 12000;

function capVisibleText(cleaned: string): string {
  if (cleaned.length <= VISIBLE_TEXT_CAP) {
    return cleaned;
  }
  const unit = cleaned.charCodeAt(VISIBLE_TEXT_CAP - 1);
  const end = unit >= 0xd800 && unit <= 0xdbff ? VISIBLE_TEXT_CAP - 1 : VISIBLE_TEXT_CAP;
  return cleaned.slice(0, end);
}
```

This removes one trailing high surrogate created by the cut. It does not scan the rest of the string. A pair that ends exactly on unit 12,000 stays. Excluded text does not consume the cap.

## Spec coverage

| Area | Test |
| --- | --- |
| 1. Well-formed HTML | `extracts a well-formed page` |
| 2. Malformed parseable HTML | `drops nested text inside excluded elements and still reads malformed html` |
| 3. Title | `extracts title meta language and viewport` |
| 4. Missing or blank title | `returns null for missing and blank metadata` |
| 5. Meta description | `extracts title meta language and viewport` |
| 6. Missing or blank description | `returns null for missing and blank metadata` |
| 7. Language | `extracts title meta language and viewport` and `returns null for missing and blank metadata` |
| 8. Viewport | `extracts title meta language and viewport` and `returns null for missing and blank metadata` |
| 9. Multiple `h1` | `counts headings images and forms` |
| 10. Mixed `h1`–`h6` | `counts headings images and forms` |
| 11. Image count | `counts headings images and forms` |
| 12. Missing `alt` | `counts headings images and forms` |
| 13. Empty `alt` | `counts headings images and forms` |
| 14. Whitespace-only `alt` | `counts headings images and forms` |
| 15. Nonblank `alt` | `counts headings images and forms` |
| 16. Form count | `counts headings images and forms` |
| 17. Relative internal links | `resolves relative links against the redirected finalUrl` |
| 18. Absolute internal links | `counts every qualifying anchor once per occurrence` |
| 19. External links | `counts every qualifying anchor once per occurrence` |
| 20. Subdomain is external | `compares hostnames with WHATWG hostname equality` |
| 21. Duplicate occurrences | `counts every qualifying anchor once per occurrence` |
| 22. Fragment href | `ignores fragment mailto tel javascript data and malformed hrefs` |
| 23. `mailto:` | `ignores fragment mailto tel javascript data and malformed hrefs` |
| 24. `tel:` | `ignores fragment mailto tel javascript data and malformed hrefs` |
| 25. `javascript:` | `ignores fragment mailto tel javascript data and malformed hrefs` |
| 26. `data:` | `ignores fragment mailto tel javascript data and malformed hrefs` |
| 27. Malformed href | `ignores fragment mailto tel javascript data and malformed hrefs` |
| 28. `script` text | `drops nested text inside excluded elements and still reads malformed html` |
| 29. `style` text | `drops nested text inside excluded elements and still reads malformed html` |
| 30. `noscript` text | `drops nested text inside excluded elements and still reads malformed html` |
| 31. `template` text | `drops nested text inside excluded elements and still reads malformed html` |
| 32. `svg` text | `drops nested text inside excluded elements and still reads malformed html` |
| 33. Whitespace normalization | `collapses visible whitespace` |
| 34. Unicode visible text | `collapses visible whitespace` and `caps visible text at the 12000 code-unit boundary` |
| 35. Exactly 12,000 characters | `caps visible text at the 12000 code-unit boundary` |
| 36. Truncation above the cap | `caps visible text at the 12000 code-unit boundary` |
| 37. Failed evidence | `rejects failed crawl evidence` |
| 38. Frozen result | `copies identity from an empty fetched document and freezes the facts` |
| 39. Repeated extraction | `copies identity from an empty fetched document and freezes the facts` |

The multiple-title and multiple-meta rule is `selects the first title and the first meta description in document order`. It is required in addition to the 39 areas.

## File map

Create:

- `src/website-analysis/errors.ts`
- `src/website-analysis/facts.ts`
- `src/website-analysis/index.ts`
- `tests/unit/website-facts.test.ts`

Modify, in Task 1 only, through `npm install parse5`:

- `package.json`
- `package-lock.json`

Public surface:

```ts
export const WEBSITE_FACTS_ERROR_CODES: readonly ["EVIDENCE_NOT_ANALYZABLE"];
export type WebsiteFactsErrorCode = (typeof WEBSITE_FACTS_ERROR_CODES)[number];

export class WebsiteFactsError extends Error {
  readonly name = "WebsiteFactsError";
  constructor(readonly code: WebsiteFactsErrorCode);
}

export type WebsiteFacts = Readonly<{
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

export function extractWebsiteFacts(
  evidence: StoredSinglePageCrawlEvidence,
): WebsiteFacts;
```

`index.ts` exports those values and types only:

```ts
export { WEBSITE_FACTS_ERROR_CODES, WebsiteFactsError } from "./errors";
export type { WebsiteFactsErrorCode } from "./errors";
export { extractWebsiteFacts } from "./facts";
export type { WebsiteFacts } from "./facts";
```

---

### Task 1: Fetched-evidence gate and metadata

**Files:**
- Create: `src/website-analysis/errors.ts`
- Create: `src/website-analysis/facts.ts`
- Create: `src/website-analysis/index.ts`
- Create: `tests/unit/website-facts.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `StoredSinglePageCrawlEvidence` from `src/crawler/evidence-domain.ts` as a type-only import. Consumes `parse` from `parse5`.
- Produces: `WebsiteFactsError`, `WEBSITE_FACTS_ERROR_CODES`, `WebsiteFactsErrorCode`, `WebsiteFacts`, and `extractWebsiteFacts(evidence: StoredSinglePageCrawlEvidence): WebsiteFacts`.

- [ ] **Create `tests/unit/website-facts.test.ts` with this file contents.**

```ts
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { normalizeSinglePageCrawlEvidence } from "../../src/crawler/evidence-domain";
import type { StoredSinglePageCrawlEvidence } from "../../src/crawler/evidence-domain";
import { normalizeWebsiteUrl } from "../../src/leads/domain";
import {
  extractWebsiteFacts,
  WEBSITE_FACTS_ERROR_CODES,
  WebsiteFactsError,
} from "../../src/website-analysis";
import type { WebsiteFacts } from "../../src/website-analysis";

const leadId = "00000000-0000-4000-8000-000000000001";
const attemptedAt = "2026-10-21T14:05:06.007Z";

function stored(
  bodyText: string,
  overrides: {
    readonly requestedUrl?: string;
    readonly finalUrl?: string;
    readonly contentType?: "text/html" | "application/xhtml+xml";
    readonly id?: number;
  } = {},
): StoredSinglePageCrawlEvidence {
  const requestedUrl =
    overrides.requestedUrl ?? normalizeWebsiteUrl("https://www.example.com/requested");
  const finalUrl = overrides.finalUrl ?? normalizeWebsiteUrl("https://www.example.com/landing");
  const evidence = normalizeSinglePageCrawlEvidence({
    outcome: "fetched",
    leadId,
    leadVersion: 4,
    requestedUrl,
    finalUrl,
    statusCode: 200,
    contentType: overrides.contentType ?? "text/html",
    bodyText,
    byteLength: Buffer.byteLength(bodyText, "utf8"),
    redirectCount: 1,
    attemptedAt,
  });
  return Object.freeze({ ...evidence, id: overrides.id ?? 17 });
}

function failedEvidence(): StoredSinglePageCrawlEvidence {
  const evidence = normalizeSinglePageCrawlEvidence({
    outcome: "failed",
    leadId,
    leadVersion: 4,
    requestedUrl: normalizeWebsiteUrl("https://www.example.com/requested"),
    failure: "TIMEOUT",
    attemptedAt,
  });
  return Object.freeze({ ...evidence, id: 17 });
}

function assertInvariants(facts: WebsiteFacts): void {
  assert.equal(Object.isFrozen(facts), true);
  const counters = [
    facts.h1Count,
    facts.headingCount,
    facts.imageCount,
    facts.imagesWithoutAlt,
    facts.formCount,
    facts.internalLinkCount,
    facts.externalLinkCount,
  ];
  for (const value of counters) {
    assert.equal(Number.isSafeInteger(value) && value >= 0, true);
  }
  assert.equal(facts.h1Count <= facts.headingCount, true);
  assert.equal(facts.imagesWithoutAlt <= facts.imageCount, true);
  assert.equal(facts.visibleText.length <= 12000, true);
}

function readTree(directory: string): string {
  return readdirSync(directory)
    .map((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? readTree(path) : readFileSync(path, "utf8");
    })
    .join("\n");
}

test("publishes the fixed website facts error code and message", () => {
  assert.equal(Object.isFrozen(WEBSITE_FACTS_ERROR_CODES), true);
  assert.deepEqual([...WEBSITE_FACTS_ERROR_CODES], ["EVIDENCE_NOT_ANALYZABLE"]);
  const error = new WebsiteFactsError("EVIDENCE_NOT_ANALYZABLE");
  assert.equal(error.name, "WebsiteFactsError");
  assert.equal(error.code, "EVIDENCE_NOT_ANALYZABLE");
  assert.equal(error.message, "Crawl evidence is not analyzable.");
  assert.equal("cause" in error, false);
});

test("rejects failed crawl evidence", () => {
  const evidence = failedEvidence();
  assert.throws(
    () => extractWebsiteFacts(evidence),
    (error: unknown) =>
      error instanceof WebsiteFactsError &&
      error.name === "WebsiteFactsError" &&
      error.code === "EVIDENCE_NOT_ANALYZABLE" &&
      error.message === "Crawl evidence is not analyzable." &&
      !("cause" in error),
  );
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(evidence.outcome, "failed");
  if (evidence.outcome !== "failed") {
    return;
  }
  assert.equal(evidence.failure, "TIMEOUT");
  assert.equal(evidence.id, 17);
});

test("copies identity from an empty fetched document and freezes the facts", () => {
  const evidence = stored("", { id: 99 });
  assert.equal(evidence.outcome, "fetched");
  if (evidence.outcome !== "fetched") {
    return;
  }
  const facts = extractWebsiteFacts(evidence);
  assertInvariants(facts);
  assert.deepEqual(facts, {
    evidenceId: 99,
    leadId,
    leadVersion: 4,
    requestedUrl: evidence.requestedUrl,
    finalUrl: evidence.finalUrl,
    title: null,
    metaDescription: null,
    documentLanguage: null,
    hasViewport: false,
    h1Count: 0,
    headingCount: 0,
    imageCount: 0,
    imagesWithoutAlt: 0,
    formCount: 0,
    internalLinkCount: 0,
    externalLinkCount: 0,
    visibleText: "",
  });
  assert.deepEqual(extractWebsiteFacts(evidence), facts);
  assert.equal(evidence.bodyText, "");
  assert.equal(Object.isFrozen(evidence), true);
});

test("extracts title meta language and viewport", () => {
  const html =
    '<html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="Description" content="  Hello   world  "><title>  Delta   Qoralis  </title></head><body lang="fr"></body></html>';
  for (const contentType of ["text/html", "application/xhtml+xml"] as const) {
    const facts = extractWebsiteFacts(stored(html, { contentType }));
    assertInvariants(facts);
    assert.equal(facts.title, "Delta Qoralis");
    assert.equal(facts.metaDescription, "Hello world");
    assert.equal(facts.documentLanguage, "en");
    assert.equal(facts.hasViewport, true);
  }
});

test("selects the first title and the first meta description in document order", () => {
  assert.equal(
    extractWebsiteFacts(stored("<title>  First  </title><title>Second</title>")).title,
    "First",
  );
  assert.equal(
    extractWebsiteFacts(stored("<title>   </title><title>Second</title>")).title,
    null,
  );
  assert.equal(
    extractWebsiteFacts(stored("<title>\u00A0</title><title>Second</title>")).title,
    null,
  );
  assert.equal(
    extractWebsiteFacts(stored("<title>A <b>B</b></title>")).title,
    "A <b>B</b>",
  );
  assert.equal(
    extractWebsiteFacts(
      stored("<template><title>Hidden</title></template><title>Shown</title>"),
    ).title,
    "Shown",
  );
  assert.equal(
    extractWebsiteFacts(
      stored(
        '<meta name="description" content="  First   line "><meta name="description" content="Second">',
      ),
    ).metaDescription,
    "First line",
  );
  assert.equal(
    extractWebsiteFacts(
      stored(
        '<meta name="description" content=" \t "><meta name="DESCRIPTION" content="Later">',
      ),
    ).metaDescription,
    null,
  );
  assert.equal(
    extractWebsiteFacts(
      stored('<meta name="description"><meta name="description" content="Later">'),
    ).metaDescription,
    null,
  );
  assert.equal(
    extractWebsiteFacts(
      stored('<meta NAME="Description" CONTENT="  Hello   world  ">'),
    ).metaDescription,
    "Hello world",
  );
  assert.equal(
    extractWebsiteFacts(
      stored(
        '<meta name="viewport" content=""><meta name="viewport" content="width=device-width">',
      ),
    ).hasViewport,
    true,
  );
});

test("returns null for missing and blank metadata", () => {
  const empty = extractWebsiteFacts(stored("<html><head></head><body></body></html>"));
  assert.equal(empty.title, null);
  assert.equal(empty.metaDescription, null);
  assert.equal(empty.documentLanguage, null);
  assert.equal(empty.hasViewport, false);

  assert.equal(extractWebsiteFacts(stored("<title> \t\n\u00A0 </title>")).title, null);
  assert.equal(
    extractWebsiteFacts(stored('<meta name="description" content=" \t\u00A0 ">')).metaDescription,
    null,
  );
  assert.equal(extractWebsiteFacts(stored('<html lang=" \t\u00A0 "></html>')).documentLanguage, null);
  assert.equal(extractWebsiteFacts(stored('<html lang="en US"></html>')).documentLanguage, "en US");
  assert.equal(
    extractWebsiteFacts(stored('<html lang="en\u00A0US"></html>')).documentLanguage,
    "en\u00A0US",
  );
  assert.equal(
    extractWebsiteFacts(
      stored('<meta http-equiv="viewport" content="width=device-width">'),
    ).hasViewport,
    false,
  );
  assert.equal(
    extractWebsiteFacts(stored("<html><body lang=\"fr\"></body></html>")).documentLanguage,
    null,
  );
});

test("crawler sources do not reference website-analysis", () => {
  assert.equal(readTree("src/crawler").includes("website-analysis"), false);
});

test("extraction does not call fetch or read the clock", () => {
  const evidence = stored("<title>Hi</title>");
  const expected = extractWebsiteFacts(evidence);
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
  wrapped.prototype = RealDate.prototype;
  globalThis.Date = wrapped;

  try {
    assert.deepEqual(extractWebsiteFacts(evidence), expected);
    assert.equal(fetchCalls, 0);
    assert.equal(dateNowCalls, 0);
    assert.equal(dateConstructs, 0);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.Date = RealDate;
  }
});
```

- [ ] **Run the targeted command from the repository root.** Expected: exit status non-zero, `node --test` does not run, and stderr contains `error TS2307: Cannot find module '../../src/website-analysis' or its corresponding type declarations.`

- [ ] **Install the parser from the repository root.**

```bash
npm install parse5
```

Expected: `package.json` `dependencies` gains `parse5`, and `package-lock.json` records the same package. No other dependency is added. `import { parse } from "parse5"` must typecheck from that install. If it does not, stop and report the installed version. Do not add a second parser or `@types/parse5`.

- [ ] **Create `src/website-analysis/errors.ts`.** Copy the shape of `src/crawler/errors.ts`. Export a frozen `WEBSITE_FACTS_ERROR_CODES` array containing only `"EVIDENCE_NOT_ANALYZABLE"`. Export `WebsiteFactsErrorCode`. The message record maps that code to `"Crawl evidence is not analyzable."` `WebsiteFactsError` sets `readonly name = "WebsiteFactsError"` and `constructor(readonly code: WebsiteFactsErrorCode)` calls `super(messages[code])`.

- [ ] **Create `src/website-analysis/facts.ts`.** Export the `WebsiteFacts` type from the public surface. `extractWebsiteFacts` throws `new WebsiteFactsError("EVIDENCE_NOT_ANALYZABLE")` when `evidence.outcome !== "fetched"`. On the fetched branch, copy `id`, `leadId`, `leadVersion`, `requestedUrl`, and `finalUrl` onto the result. Call `parse(evidence.bodyText)` and apply the first-applicable metadata algorithm. Set `h1Count`, `headingCount`, `imageCount`, `imagesWithoutAlt`, `formCount`, `internalLinkCount`, and `externalLinkCount` to `0`. Set `visibleText` to `""`. Return `Object.freeze` of that object. Do not mutate `evidence`.

- [ ] **Create `src/website-analysis/index.ts` with the public exports in the File map.**

- [ ] **Run the targeted command again.** Expected: exit status 0, and the output contains `# tests 8`, `# pass 8`, and `# fail 0`.

- [ ] **Run `git diff --check`.** Expected: no whitespace errors.

- [ ] **Run `git status --short`.** Expected paths, and no others: `package.json`, `package-lock.json`, `src/website-analysis/errors.ts`, `src/website-analysis/facts.ts`, `src/website-analysis/index.ts`, `tests/unit/website-facts.test.ts`.

- [ ] **After Analyst APPROVED, commit.**

```bash
git add package.json package-lock.json src/website-analysis/errors.ts src/website-analysis/facts.ts src/website-analysis/index.ts tests/unit/website-facts.test.ts
git commit -m "feat: extract website facts metadata from fetched evidence"
```

---

### Task 2: Heading, image, and form counts

**Files:**
- Modify: `src/website-analysis/facts.ts`
- Modify: `tests/unit/website-facts.test.ts`

**Interfaces:**
- Consumes: `extractWebsiteFacts(evidence: StoredSinglePageCrawlEvidence): WebsiteFacts` and the element walk from Task 1.
- Produces: the same function and the same `WebsiteFacts` type. No signature change. `h1Count`, `headingCount`, `imageCount`, `imagesWithoutAlt`, and `formCount` become real counts.

- [ ] **Append these tests to `tests/unit/website-facts.test.ts`.**

```ts
test("counts headings images and forms", () => {
  const facts = extractWebsiteFacts(
    stored(
      '<h1></h1><h1>A</h1><h2>B</h2><h3></h3><h4></h4><h5></h5><h6>F</h6><H1>c</H1><img><img alt=""><img alt=" \t\n"><img alt=" ok "><img alt="0"><svg><image href="x"></image></svg><picture><img alt="photo"></picture><form></form><div><form></form></div>',
    ),
  );
  assertInvariants(facts);
  assert.equal(facts.h1Count, 3);
  assert.equal(facts.headingCount, 8);
  assert.equal(facts.imageCount, 6);
  assert.equal(facts.imagesWithoutAlt, 3);
  assert.equal(facts.formCount, 2);
});

test("ignores heading image and form markup inside template and noscript", () => {
  const noscript = extractWebsiteFacts(
    stored('<noscript><h1>Secret</h1><img alt="x"></noscript><h2>Shown</h2>'),
  );
  assertInvariants(noscript);
  assert.equal(noscript.h1Count, 0);
  assert.equal(noscript.headingCount, 1);
  assert.equal(noscript.imageCount, 0);
  assert.equal(noscript.formCount, 0);

  const template = extractWebsiteFacts(
    stored('<template><h1>Hidden</h1><img><form></form></template><h2>Shown</h2><img alt="ok">'),
  );
  assertInvariants(template);
  assert.equal(template.h1Count, 0);
  assert.equal(template.headingCount, 1);
  assert.equal(template.imageCount, 1);
  assert.equal(template.imagesWithoutAlt, 0);
  assert.equal(template.formCount, 0);
});
```

- [ ] **Run the targeted command.** Expected: exit status 1. The output contains `not ok` for `counts headings images and forms` and for `ignores heading image and form markup inside template and noscript`. The heading assertion reports that `0` is not `3`. The first eight tests still pass.

- [ ] **Fill the five counters during the element walk in `src/website-analysis/facts.ts`.** Count `h1` through `h6`. `h1Count` counts `h1` only. `headingCount` counts all six. `imageCount` counts `img` only, so an svg `image` adds nothing. `imagesWithoutAlt` counts an `img` whose `alt` attribute is absent or whose `trimWhitespace(alt)` is empty; `alt=" ok "` and `alt="0"` stay out of that count. `formCount` counts `form` elements. Because the walk does not follow `template.content`, and default `parse` leaves `noscript` contents as text, markup inside those two places adds nothing. Leave link counters at `0` and `visibleText` at `""`.

- [ ] **Run the targeted command.** Expected: exit status 0, `# tests 10`, `# pass 10`, and `# fail 0`.

- [ ] **Run `git diff --check`.** Expected: no whitespace errors.

- [ ] **Run `git status --short`.** Expected paths, and no others: `src/website-analysis/facts.ts` and `tests/unit/website-facts.test.ts`.

- [ ] **After Analyst APPROVED, commit.**

```bash
git add src/website-analysis/facts.ts tests/unit/website-facts.test.ts
git commit -m "feat: count website heading image and form facts"
```

---

### Task 3: Internal and external link counts

**Files:**
- Modify: `src/website-analysis/facts.ts`
- Modify: `tests/unit/website-facts.test.ts`

**Interfaces:**
- Consumes: `extractWebsiteFacts(evidence: StoredSinglePageCrawlEvidence): WebsiteFacts` and `evidence.finalUrl` on the fetched branch.
- Produces: the same signature. `internalLinkCount` and `externalLinkCount` become real counts.

- [ ] **Append these tests to `tests/unit/website-facts.test.ts`.**

```ts
test("resolves relative links against the redirected finalUrl", () => {
  const evidence = stored(
    '<a href="/pricing"></a><a href="pricing"></a><a href="https://requested.example/keep"></a><a href="//cdn.example/lib"></a>',
    {
      requestedUrl: normalizeWebsiteUrl("https://requested.example/old"),
      finalUrl: normalizeWebsiteUrl("https://final.example/landed/page"),
    },
  );
  const facts = extractWebsiteFacts(evidence);
  assertInvariants(facts);
  assert.equal(facts.requestedUrl, "https://requested.example/old");
  assert.equal(facts.finalUrl, "https://final.example/landed/page");
  assert.equal(facts.internalLinkCount, 2);
  assert.equal(facts.externalLinkCount, 2);
});

test("counts every qualifying anchor once per occurrence", () => {
  const facts = extractWebsiteFacts(
    stored(
      '<a href="https://www.example.com/a"></a><a href="https://www.example.com/a"></a><a href="https://other.example/b"></a><a href="https://other.example/b"></a><template><a href="/in"></a></template><svg><a href="https://other.example/x"></a></svg><a></a>',
    ),
  );
  assertInvariants(facts);
  assert.equal(facts.internalLinkCount, 2);
  assert.equal(facts.externalLinkCount, 3);
});

test("compares hostnames with WHATWG hostname equality", () => {
  const mixed = extractWebsiteFacts(
    stored(
      '<a href="https://WWW.EXAMPLE.COM/a"></a><a href="https://www.example.com:443/b"></a><a href="http://www.example.com:80/c"></a><a href="https://www.example.com:8443/d"></a><a href="https://example.com/e"></a><a href="https://blog.example.com/f"></a><a href="https://www.example.com./g"></a>',
      { finalUrl: normalizeWebsiteUrl("https://www.example.com:8443/landing") },
    ),
  );
  assertInvariants(mixed);
  assert.equal(mixed.finalUrl, "https://www.example.com:8443/landing");
  assert.equal(mixed.internalLinkCount, 4);
  assert.equal(mixed.externalLinkCount, 3);

  const idn = extractWebsiteFacts(
    stored('<a href="https://bücher.example/h"></a><a href="https://xn--bcher-kva.example/other"></a>', {
      finalUrl: normalizeWebsiteUrl("https://xn--bcher-kva.example/home"),
    }),
  );
  assertInvariants(idn);
  assert.equal(idn.internalLinkCount, 2);
  assert.equal(idn.externalLinkCount, 0);
});

test("ignores fragment mailto tel javascript data and malformed hrefs", () => {
  const facts = extractWebsiteFacts(
    stored(
      '<a href="#top"></a><a href="  #top  "></a><a href=""></a><a href="   "></a><a href="mailto:a@b.c"></a><a href="tel:123"></a><a href="javascript:alert(1)"></a><a href="data:text/plain,hi"></a><a href="http://["></a><a href="ftp://files.example/a"></a><a href="https://other.example/a"></a>',
    ),
  );
  assertInvariants(facts);
  assert.equal(facts.internalLinkCount, 2);
  assert.equal(facts.externalLinkCount, 1);
});
```

- [ ] **Run the targeted command.** Expected: exit status 1. The output contains `not ok` for `resolves relative links against the redirected finalUrl`, and the internal-link assertion reports that `0` is not `2`. The previous ten tests still pass.

- [ ] **Count links in `src/website-analysis/facts.ts` with the Links algorithm.** Use `evidence.finalUrl` as the base string exactly as stored. Catch only `TypeError` from `new URL`. Do not call `normalizeNetworkUrl` or `normalizeWebsiteUrl`. One qualifying `a` occurrence adds one to `internalLinkCount` or `externalLinkCount`. Leave `visibleText` as `""`.

- [ ] **Run the targeted command.** Expected: exit status 0, `# tests 14`, `# pass 14`, and `# fail 0`.

- [ ] **Run `git diff --check`.** Expected: no whitespace errors.

- [ ] **Run `git status --short`.** Expected paths, and no others: `src/website-analysis/facts.ts` and `tests/unit/website-facts.test.ts`.

- [ ] **After Analyst APPROVED, commit.**

```bash
git add src/website-analysis/facts.ts tests/unit/website-facts.test.ts
git commit -m "feat: count internal and external website links"
```

---

### Task 4: Cleaned and capped visible text

**Files:**
- Modify: `src/website-analysis/facts.ts`
- Modify: `tests/unit/website-facts.test.ts`

**Interfaces:**
- Consumes: `extractWebsiteFacts(evidence: StoredSinglePageCrawlEvidence): WebsiteFacts` and the fetched `bodyText`.
- Produces: the same signature. `visibleText` becomes the collapsed, capped string. `visibleText.length <= 12000`.

- [ ] **Append these tests to `tests/unit/website-facts.test.ts`.**

```ts
test("drops nested text inside excluded elements and still reads malformed html", () => {
  const excluded = extractWebsiteFacts(
    stored(
      '<div>Keep</div> <script>SCRIPT_SECRET <b>SCRIPT_NESTED</b></script> <style>STYLE_SECRET</style> <noscript>NOSCRIPT_SECRET</noscript> <template>TEMPLATE_SECRET <span>TEMPLATE_NESTED</span></template> <svg><text>SVG_SECRET <tspan>SVG_NESTED</tspan></text></svg> <div>End</div>',
    ),
  );
  assertInvariants(excluded);
  assert.equal(excluded.visibleText, "Keep End");
  for (const token of [
    "SCRIPT_SECRET",
    "SCRIPT_NESTED",
    "STYLE_SECRET",
    "NOSCRIPT_SECRET",
    "TEMPLATE_SECRET",
    "TEMPLATE_NESTED",
    "SVG_SECRET",
    "SVG_NESTED",
  ]) {
    assert.equal(excluded.visibleText.includes(token), false);
  }

  const unclosed = extractWebsiteFacts(
    stored("<title>Hi</title> <div>Keep <script>SECRET</div> after"),
  );
  assert.equal(unclosed.title, "Hi");
  assert.equal(unclosed.visibleText, "Hi Keep");
  assert.equal(unclosed.visibleText.includes("SECRET"), false);
  assert.equal(unclosed.visibleText.includes("after"), false);

  const recovered = extractWebsiteFacts(stored("<p>Hello <b>world</p> tail"));
  assert.equal(recovered.visibleText, "Hello world tail");

  const broken = extractWebsiteFacts(stored("<<<"));
  assert.equal(broken.title, null);
  assert.equal(broken.visibleText, "<<<");

  const inert = extractWebsiteFacts(
    stored(
      '<template><h1>Hidden</h1><img alt="x"><form></form><a href="/in">In</a></template><h2>Shown</h2>',
    ),
  );
  assert.equal(inert.visibleText, "Shown");
  assert.equal(inert.visibleText.includes("Hidden"), false);
  assert.equal(inert.visibleText.includes("In"), false);
  assert.equal(inert.h1Count, 0);
  assert.equal(inert.headingCount, 1);
  assert.equal(inert.imageCount, 0);
  assert.equal(inert.formCount, 0);
  assert.equal(inert.internalLinkCount, 0);
});

test("collapses visible whitespace", () => {
  const facts = extractWebsiteFacts(stored("<p>héllo   世界</p> <p>A\u00A0\u00A0B</p>"));
  assertInvariants(facts);
  assert.equal(facts.visibleText, "héllo 世界 A B");
  assert.equal(extractWebsiteFacts(stored("<div>Hello\t\nworld</div>")).visibleText, "Hello world");
});

test("caps visible text at the 12000 code-unit boundary", () => {
  const exact = extractWebsiteFacts(stored(`<p>${"é"}${"a".repeat(11999)}</p>`));
  assert.equal(exact.visibleText.length, 12000);
  assert.equal(exact.visibleText, `${"é"}${"a".repeat(11999)}`);

  const ascii = extractWebsiteFacts(stored(`<p>${"a".repeat(12001)}</p>`));
  assert.equal(ascii.visibleText.length, 12000);
  assert.equal(ascii.visibleText, "a".repeat(12000));

  const pair = extractWebsiteFacts(stored(`<p>${"a".repeat(11998)}😀</p>`));
  assert.equal(pair.visibleText.length, 12000);
  assert.equal(pair.visibleText.codePointAt(11998), 0x1f600);

  const split = extractWebsiteFacts(stored(`<p>${"a".repeat(11999)}😀zzz</p>`));
  assert.equal(split.visibleText, "a".repeat(11999));
  assert.equal(split.visibleText.length, 11999);
  const last = split.visibleText.charCodeAt(split.visibleText.length - 1);
  assert.equal(last >= 0xd800 && last <= 0xdbff, false);
  assert.equal(split.visibleText.includes("😀"), false);

  const padded = extractWebsiteFacts(stored(`<p>${"  "}${"a".repeat(12001)}${"  "}</p>`));
  assert.equal(padded.visibleText, "a".repeat(12000));

  const script = extractWebsiteFacts(
    stored(`<script>${"a".repeat(13000)}</script><p>Hi</p>`),
  );
  assert.equal(script.visibleText, "Hi");
});

test("extracts a well-formed page", () => {
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="  A   studio  "><title>  Delta   Qoralis  </title></head><body><h1>Hello</h1> <img alt="Logo" src="/logo.png"><form action="/contact"></form><a href="/contact">Contact</a></body></html>';
  const evidence = stored(html);
  assert.equal(evidence.outcome, "fetched");
  if (evidence.outcome !== "fetched") {
    return;
  }
  const facts = extractWebsiteFacts(evidence);
  assertInvariants(facts);
  assert.equal(Object.isFrozen(facts), true);
  assert.deepEqual(facts, {
    evidenceId: 17,
    leadId,
    leadVersion: 4,
    requestedUrl: evidence.requestedUrl,
    finalUrl: evidence.finalUrl,
    title: "Delta Qoralis",
    metaDescription: "A studio",
    documentLanguage: "en",
    hasViewport: true,
    h1Count: 1,
    headingCount: 1,
    imageCount: 1,
    imagesWithoutAlt: 0,
    formCount: 1,
    internalLinkCount: 1,
    externalLinkCount: 0,
    visibleText: "Delta Qoralis Hello Contact",
  });
  assert.deepEqual(extractWebsiteFacts(evidence), facts);
  assert.equal(evidence.bodyText, html);
});
```

- [ ] **Run the targeted command.** Expected: exit status 1. The output contains `not ok` for `drops nested text inside excluded elements and still reads malformed html`, and the visible-text assertion reports that `""` is not `"Keep End"`. The previous fourteen tests still pass.

- [ ] **Set `visibleText` in `src/website-analysis/facts.ts` from the Excluded visible text algorithm, then `capVisibleText`.** Do not copy `bodyText` into the field. Do not change the metadata, counter, or link rules.

- [ ] **Run the targeted command.** Expected: exit status 0, `# tests 18`, `# pass 18`, and `# fail 0`.

- [ ] **Run `npm test` from the repository root.** Expected: exit status 0 and `# fail 0`. The new file contributes 18 passing tests. Existing crawler tests still pass.

- [ ] **Run `npm run typecheck`.** Expected: exit status 0.

- [ ] **Run `git diff --check`.** Expected: no whitespace errors.

- [ ] **Run `git status --short`.** Expected paths, and no others: `src/website-analysis/facts.ts` and `tests/unit/website-facts.test.ts`.

- [ ] **After Analyst APPROVED, commit.**

```bash
git add src/website-analysis/facts.ts tests/unit/website-facts.test.ts
git commit -m "feat: cap cleaned visible website text"
```

- [ ] **Run `git status --short`.** Expected: empty output. Do not push.
