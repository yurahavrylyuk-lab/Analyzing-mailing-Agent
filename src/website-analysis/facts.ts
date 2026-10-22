import { parse, type DefaultTreeAdapterMap } from "parse5";

import type { StoredSinglePageCrawlEvidence } from "../crawler/evidence-domain";
import { WebsiteFactsError } from "./errors";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

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

function collapseWhitespace(value: string): string {
  const run = /[\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
  return value.replace(run, " ").replace(/^ | $/g, "");
}

function trimWhitespace(value: string): string {
  const edge = /[\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/;
  return value.replace(new RegExp(`^${edge.source}`), "").replace(new RegExp(`${edge.source}$`), "");
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function isText(node: Node): node is TextNode {
  return node.nodeName === "#text";
}

function childNodesOf(node: Node): readonly Node[] {
  if ("childNodes" in node) {
    return node.childNodes;
  }
  return [];
}

function walkElements(node: Node, visit: (element: Element) => void): void {
  for (const child of childNodesOf(node)) {
    if (isElement(child)) {
      visit(child);
      walkElements(child, visit);
    }
  }
}

function textValue(node: Node): string {
  if (isText(node)) {
    return node.value;
  }

  let value = "";
  for (const child of childNodesOf(node)) {
    value += textValue(child);
  }
  return value;
}

function attributeValue(element: Element, name: string): string | undefined {
  for (const attribute of element.attrs) {
    if (attribute.name === name) {
      return attribute.value;
    }
  }
  return undefined;
}

function presentText(value: string): string | null {
  return value.length === 0 ? null : value;
}

const VISIBLE_TEXT_CAP = 12000;
const excludedVisibleTags = new Set(["script", "style", "noscript", "template", "svg"]);

function capVisibleText(cleaned: string): string {
  if (cleaned.length <= VISIBLE_TEXT_CAP) {
    return cleaned;
  }

  const unit = cleaned.charCodeAt(VISIBLE_TEXT_CAP - 1);
  const end = unit >= 0xd800 && unit <= 0xdbff ? VISIBLE_TEXT_CAP - 1 : VISIBLE_TEXT_CAP;
  return cleaned.slice(0, end);
}

function visibleTextValue(node: Node): string {
  if (isText(node)) {
    return node.value;
  }

  if (isElement(node) && excludedVisibleTags.has(node.tagName)) {
    return "";
  }

  let value = "";
  for (const child of childNodesOf(node)) {
    value += visibleTextValue(child);
  }
  return value;
}

export function extractWebsiteFacts(evidence: StoredSinglePageCrawlEvidence): WebsiteFacts {
  if (evidence.outcome !== "fetched") {
    throw new WebsiteFactsError("EVIDENCE_NOT_ANALYZABLE");
  }

  const document = parse(evidence.bodyText);
  let title: string | null = null;
  let titleFound = false;
  let metaDescription: string | null = null;
  let metaFound = false;
  let documentLanguage: string | null = null;
  let languageFound = false;
  let hasViewport = false;
  let h1Count = 0;
  let headingCount = 0;
  let imageCount = 0;
  let imagesWithoutAlt = 0;
  let formCount = 0;
  let internalLinkCount = 0;
  let externalLinkCount = 0;
  const headingTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
  const baseHostname = new URL(evidence.finalUrl).hostname;

  walkElements(document, (element) => {
    if (!titleFound && element.tagName === "title") {
      titleFound = true;
      title = presentText(collapseWhitespace(textValue(element)));
    }

    if (element.tagName === "meta") {
      const name = attributeValue(element, "name");
      if (name !== undefined && name.toLowerCase() === "description" && !metaFound) {
        metaFound = true;
        const content = attributeValue(element, "content");
        metaDescription =
          content === undefined ? null : presentText(collapseWhitespace(content));
      }
      if (name !== undefined && name.toLowerCase() === "viewport") {
        hasViewport = true;
      }
    }

    if (!languageFound && element.tagName === "html") {
      languageFound = true;
      const language = attributeValue(element, "lang");
      documentLanguage =
        language === undefined ? null : presentText(trimWhitespace(language));
    }

    if (headingTags.has(element.tagName)) {
      headingCount += 1;
      if (element.tagName === "h1") {
        h1Count += 1;
      }
    }

    if (element.tagName === "img") {
      imageCount += 1;
      const alt = attributeValue(element, "alt");
      if (alt === undefined || trimWhitespace(alt).length === 0) {
        imagesWithoutAlt += 1;
      }
    }

    if (element.tagName === "form") {
      formCount += 1;
    }

    if (element.tagName === "a") {
      const raw = attributeValue(element, "href");
      if (raw !== undefined && !trimWhitespace(raw).startsWith("#")) {
        try {
          const resolved = new URL(raw, evidence.finalUrl);
          if (resolved.protocol === "http:" || resolved.protocol === "https:") {
            if (resolved.hostname === baseHostname) {
              internalLinkCount += 1;
            } else {
              externalLinkCount += 1;
            }
          }
        } catch (error) {
          if (!(error instanceof TypeError)) {
            throw error;
          }
        }
      }
    }
  });

  return Object.freeze({
    evidenceId: evidence.id,
    leadId: evidence.leadId,
    leadVersion: evidence.leadVersion,
    requestedUrl: evidence.requestedUrl,
    finalUrl: evidence.finalUrl,
    title,
    metaDescription,
    documentLanguage,
    hasViewport,
    h1Count,
    headingCount,
    imageCount,
    imagesWithoutAlt,
    formCount,
    internalLinkCount,
    externalLinkCount,
    visibleText: capVisibleText(collapseWhitespace(visibleTextValue(document))),
  });
}
