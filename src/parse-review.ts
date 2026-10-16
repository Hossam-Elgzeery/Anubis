import { z } from "zod";

const findingSchema = z.object({
  file: z.string().min(1),
  line: z.coerce.number().int().min(0),
  severity: z.enum(["critical", "high", "medium", "low"]),
  issue: z.string().min(1),
  impact: z.string().min(1),
  suggestion: z.string().min(1),
});

const resultSchema = z.object({
  findings: z.array(findingSchema),
});

export type AIReviewResult = z.infer<typeof resultSchema>;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getField(object: Record<string, unknown>, aliases: string[]): unknown {
  const normalizedAliases = new Set(aliases.map(normalizeKey));

  for (const [key, value] of Object.entries(object)) {
    if (
      normalizedAliases.has(normalizeKey(key)) &&
      value !== undefined &&
      value !== null
    ) {
      return value;
    }
  }

  return undefined;
}

function normalizeFinding(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const finding = value as Record<string, unknown>;

  return {
    file: getField(finding, ["file", "filePath", "path"]),
    line: getField(finding, ["line", "lineNumber"]),
    severity: getField(finding, ["severity", "priority"]),
    issue: getField(finding, ["issue", "title", "description"]),
    impact: getField(finding, ["impact", "reason", "explanation"]),
    suggestion: getField(finding, [
      "suggestion",
      "suggestedFix",
      "recommendation",
      "fix",
    ]),
  };
}

export function parseAIReview(response: string): AIReviewResult {
  const cleaned = response
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  if (!cleaned) {
    throw new Error("AI model returned an empty response");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      "AI model returned invalid JSON:\n" + cleaned.slice(0, 500),
    );
  }

  const rawFindings = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "findings" in parsed
      ? (parsed as { findings: unknown }).findings
      : undefined;

  if (!Array.isArray(rawFindings)) {
    throw new Error("AI response must contain a findings array");
  }

  return resultSchema.parse({
    findings: rawFindings.map(normalizeFinding),
  });
}
