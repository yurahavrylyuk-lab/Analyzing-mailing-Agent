import type { WebsiteFacts } from "./facts";
import { WebsiteAnalysisError } from "./analysis-errors";

export type WebsiteAnalysisCategory =
  | "design"
  | "usability"
  | "seo"
  | "accessibility"
  | "conversion";

export type WebsiteAnalysisSeverity = "low" | "medium" | "high";

export type WebsiteAnalysisFinding = Readonly<{
  category: WebsiteAnalysisCategory;
  severity: WebsiteAnalysisSeverity;
  observation: string;
  evidence: string;
  recommendation: string;
}>;

export type WebsiteAnalysis = Readonly<{
  evidenceId: number;
  leadId: string;
  leadVersion: number;
  summary: string;
  findings: readonly WebsiteAnalysisFinding[];
}>;

const rootKeys = ["evidenceId", "leadId", "leadVersion", "summary", "findings"] as const;
const findingKeys = [
  "category",
  "severity",
  "observation",
  "evidence",
  "recommendation",
] as const;
const categories: readonly WebsiteAnalysisCategory[] = [
  "design",
  "usability",
  "seo",
  "accessibility",
  "conversion",
];
const severities: readonly WebsiteAnalysisSeverity[] = ["low", "medium", "high"];

function invalid(): never {
  throw new WebsiteAnalysisError("INVALID_ANALYSIS");
}

function mismatch(): never {
  throw new WebsiteAnalysisError("ANALYSIS_IDENTITY_MISMATCH");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  if (names.length !== keys.length) {
    return false;
  }
  return keys.every((key) => hasOwn(value, key));
}

function ownValue(value: object, key: string): unknown {
  if (!hasOwn(value, key)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function trimmedText(value: unknown, maximum: number): string {
  if (typeof value !== "string") {
    invalid();
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) {
    invalid();
  }
  return trimmed;
}

function isCategory(value: string): value is WebsiteAnalysisCategory {
  return categories.some((category) => category === value);
}

function isSeverity(value: string): value is WebsiteAnalysisSeverity {
  return severities.some((severity) => severity === value);
}

function readFindings(findings: readonly unknown[]): WebsiteAnalysisFinding[] {
  if (findings.length > 8) {
    invalid();
  }

  const counts: Record<WebsiteAnalysisCategory, number> = {
    design: 0,
    usability: 0,
    seo: 0,
    accessibility: 0,
    conversion: 0,
  };
  const accepted: WebsiteAnalysisFinding[] = [];
  for (const item of findings) {
    if (!isPlainObject(item) || !hasExactOwnKeys(item, findingKeys)) {
      invalid();
    }
    const category = ownValue(item, "category");
    const severity = ownValue(item, "severity");
    if (typeof category !== "string" || !isCategory(category)) {
      invalid();
    }
    if (typeof severity !== "string" || !isSeverity(severity)) {
      invalid();
    }
    counts[category] += 1;
    if (counts[category] > 3) {
      invalid();
    }
    accepted.push({
      category,
      severity,
      observation: trimmedText(ownValue(item, "observation"), 500),
      evidence: trimmedText(ownValue(item, "evidence"), 800),
      recommendation: trimmedText(ownValue(item, "recommendation"), 500),
    });
  }
  return accepted;
}

export function validateWebsiteAnalysis(
  facts: WebsiteFacts,
  candidate: unknown,
): WebsiteAnalysis {
  if (!isPlainObject(candidate)) {
    invalid();
  }

  if (
    !hasOwn(candidate, "evidenceId") ||
    !hasOwn(candidate, "leadId") ||
    !hasOwn(candidate, "leadVersion")
  ) {
    invalid();
  }

  const evidenceId = ownValue(candidate, "evidenceId");
  const leadId = ownValue(candidate, "leadId");
  const leadVersion = ownValue(candidate, "leadVersion");
  if (
    typeof evidenceId !== "number" ||
    typeof leadId !== "string" ||
    typeof leadVersion !== "number"
  ) {
    invalid();
  }
  if (
    evidenceId !== facts.evidenceId ||
    leadId !== facts.leadId ||
    leadVersion !== facts.leadVersion
  ) {
    mismatch();
  }

  if (!hasExactOwnKeys(candidate, rootKeys)) {
    invalid();
  }

  const summary = trimmedText(ownValue(candidate, "summary"), 800);
  const findings = ownValue(candidate, "findings");
  if (!Array.isArray(findings)) {
    invalid();
  }

  const built = readFindings(findings);
  const frozenFindings = built.map((finding) => Object.freeze(finding));
  return Object.freeze({
    evidenceId: facts.evidenceId,
    leadId: facts.leadId,
    leadVersion: facts.leadVersion,
    summary,
    findings: Object.freeze(frozenFindings),
  });
}
