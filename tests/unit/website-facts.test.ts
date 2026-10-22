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
  Object.defineProperty(wrapped, "prototype", { value: RealDate.prototype });
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
