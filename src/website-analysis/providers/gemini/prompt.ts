export const GEMINI_WEBSITE_ANALYSIS_PROMPT = [
  "Analyze only the supplied website facts.",
  "Use only these categories: design, usability, seo, accessibility, conversion.",
  "Use only these severities: low, medium, high.",
  "Each finding must include observation, evidence, and recommendation.",
  "Do not invent facts.",
  "Do not infer from screenshots or visuals that the supplied facts do not support.",
  "Do not make qualification decisions.",
  "Do not recommend contacts.",
  "Do not generate outreach.",
  "Do not assign scores.",
  "Do not add semantic fields beyond evidenceId, leadId, leadVersion, summary, and findings.",
].join("\n");

export const GEMINI_RESPONSE_FORMAT = {
  type: "text",
  mime_type: "application/json",
  schema: {
    type: "object",
    properties: {
      evidenceId: { type: "integer" },
      leadId: { type: "string" },
      leadVersion: { type: "integer" },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["design", "usability", "seo", "accessibility", "conversion"] },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            observation: { type: "string" },
            evidence: { type: "string" },
            recommendation: { type: "string" },
          },
          required: ["category", "severity", "observation", "evidence", "recommendation"],
        },
      },
    },
    required: ["evidenceId", "leadId", "leadVersion", "summary", "findings"],
  },
};
