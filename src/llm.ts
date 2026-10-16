import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { z } from "zod";

import type { AnubisConfig } from "./config.js";
import type { StaticIssue } from "./eslint.js";
import type { ReviewChunk } from "./git.js";
import { parseAIReview } from "./parse-review.js";
import { buildReviewPrompt } from "./prompt-builder.js";

const SYSTEM_PROMPT = "You are Anubis, a precise code reviewer. Follow the supplied review task and return only the requested output.";

export const reviewSchema = z.object({
  findings: z.array(z.object({
    file: z.string(),
    line: z.number().int().min(1),
    severity: z.enum(["critical", "high", "medium", "low"]),
    issue: z.string(),
    impact: z.string(),
    suggestion: z.string(),
  })),
});

export type AIReviewResult = z.infer<typeof reviewSchema>;

const reviewJsonSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer", minimum: 1 },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          issue: { type: "string" },
          impact: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["file", "line", "severity", "issue", "impact", "suggestion"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

async function validateFindingLocations(
  result: AIReviewResult,
  cwd: string = process.cwd(),
): Promise<{ review: AIReviewResult; dropped: number }> {
  const validated: AIReviewResult["findings"] = [];
  let dropped = 0;
  const lineCounts = new Map<string, number>();
  for (const finding of result.findings) {
    const absolute = resolve(cwd, finding.file);
    const relativePath = relative(cwd, absolute);
    if (
      !finding.file || isAbsolute(finding.file) || relativePath === ".." ||
      relativePath.startsWith("../") || relativePath.startsWith("..\\") ||
      !/\.(js|jsx|ts|tsx)$/i.test(finding.file)
    ) {
      dropped++;
      continue;
    }
    let lineCount = lineCounts.get(absolute);
    if (lineCount === undefined) {
      try {
        lineCount = (await readFile(absolute, "utf8")).split(/\r?\n/).length;
        lineCounts.set(absolute, lineCount);
      } catch {
        dropped++;
        continue;
      }
    }
    if (finding.line > lineCount) {
      dropped++;
      continue;
    }
    validated.push(finding);
  }
  return { review: { findings: validated }, dropped };
}

function formatRanges(chunk: ReviewChunk): string {
  const ranges = chunk.ownedRanges.map((range) =>
    range.startLine === range.endLine
      ? String(range.startLine)
      : `${range.startLine}-${range.endLine}`,
  ).join(", ");
  return chunk.isUntracked ? `${ranges} (untracked file)` : ranges;
}

function resolveThoughtBudget(config: AnubisConfig): number | undefined {
  const mode = config.model.thinkingMode;
  if (mode === "unbounded") return undefined;
  if (mode === "zero") return 0;
  if (mode === "bounded") return config.model.thoughtTokens;
  if (/qwen[\s._-]*3/i.test(config.model.path))
    return Math.min(config.model.thoughtTokens, Math.max(1, config.model.maxTokens - 256));
  return undefined;
}

export interface ChunkReviewResult {
  review: AIReviewResult;
  failures: Array<{
    file: string;
    ranges: ReviewChunk["ownedRanges"];
    isUntracked: boolean;
    reason: string;
  }>;
}

export async function runAIReview(
  chunks: ReviewChunk[],
  rules: string,
  eslintResults: StaticIssue[],
  config: AnubisConfig,
): Promise<ChunkReviewResult> {
  await access(config.model.path);
  const debug = process.env.ANUBIS_DEBUG === "1";
  console.log("🧠 Loading local AI model...");
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath: config.model.path });
  const findings: AIReviewResult["findings"] = [];
  const failures: ChunkReviewResult["failures"] = [];
  const thoughtBudget = resolveThoughtBudget(config);
  const useGrammar = !(/qwen[\s._-]*3/i.test(config.model.path) && config.model.thinkingMode !== "zero");
  const grammar = useGrammar
    ? await llama.createGrammarForJsonSchema(reviewJsonSchema)
    : undefined;
  console.log(`🧠 Thinking strategy: ${config.model.thinkingMode}` +
    (thoughtBudget === undefined ? " (SDK default)" : ` (${thoughtBudget} thought tokens)`));
  console.log(useGrammar
    ? "🧾 Structured grammar: enabled"
    : "🧾 Structured grammar: disabled for Qwen3 thinking output");

  try {
    for (const [index, chunk] of chunks.entries()) {
      console.log(`\n🧩 Reviewing chunk ${index + 1}/${chunks.length}`);
      console.log(`   File:    ${chunk.file}`);
      console.log(`   Changes: ${formatRanges(chunk)}`);
      console.log(`   Context: ${chunk.startLine}-${chunk.endLine}`);
      const relevantESLint = eslintResults.filter((issue) =>
        issue.file === chunk.file && chunk.ownedRanges.some((range) =>
          issue.line >= range.startLine && issue.line <= range.endLine,
        ),
      );
      const prompt = await buildReviewPrompt(chunk.context, relevantESLint, rules);
      let context: Awaited<ReturnType<typeof model.createContext>> | undefined;
      try {
        context = await model.createContext({ contextSize: config.model.contextSize });
        const session = new LlamaChatSession({
          contextSequence: context.getSequence(),
          systemPrompt: SYSTEM_PROMPT,
        });
        let responseTokens = 0;
        let allTokens = 0;
        const segmentTypes = new Set<string>();
        const thoughtChunks: string[] = [];
        const started = performance.now();
        const result = await session.promptWithMeta(prompt, {
          temperature: config.model.temperature,
          maxTokens: config.model.maxTokens,
          ...(thoughtBudget === undefined ? {} : { budgets: { thoughtTokens: thoughtBudget } }),
          ...(grammar ? { grammar } : {}),
          onToken: (tokens) => { responseTokens += tokens.length; },
          onResponseChunk: (part) => {
            allTokens += part.tokens.length;
            if (part.segmentType) segmentTypes.add(part.segmentType);
            if (debug && part.segmentType === "thought" && part.text)
              thoughtChunks.push(part.text);
          },
        });
        if (debug) {
          console.log("\n🧠 Raw AI response:", result.responseText);
          console.log("🛑 Stop reason:", result.stopReason);
          console.log("🧮 Response tokens:", responseTokens);
          console.log("🧮 All streamed tokens:", allTokens);
          console.log("🧠 Segment types:", [...segmentTypes]);
          console.log("⏱️ Generation duration:", ((performance.now() - started) / 1000).toFixed(1), "seconds");
          console.log("🧠 Thought preview:", thoughtChunks.join("").slice(0, 3000));
        }
        const parsed = reviewSchema.parse(parseAIReview(result.responseText));
        const validated = await validateFindingLocations(parsed);
        const owned = validated.review.findings.filter((finding) =>
          finding.file === chunk.file && chunk.ownedRanges.some((range) =>
            finding.line >= range.startLine && finding.line <= range.endLine,
          ),
        );
        findings.push(...owned);
        console.log(`✔ Chunk reviewed: ${owned.length} findings`);
        if (debug) {
          console.log(`   Raw:                   ${parsed.findings.length}`);
          console.log(`   Accepted:              ${owned.length}`);
          console.log(`   Dropped invalid:       ${validated.dropped}`);
          console.log(`   Dropped outside scope: ${validated.review.findings.length - owned.length}`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({
          file: chunk.file,
          ranges: chunk.ownedRanges,
          isUntracked: chunk.isUntracked,
          reason,
        });
        console.warn(`⚠️ Chunk review failed: ${chunk.file} [${formatRanges(chunk)}]`);
        if (debug) console.warn(error);
      } finally {
        await context?.dispose();
      }
    }
  } finally {
    await model.dispose();
  }

  const unique = new Map<string, AIReviewResult["findings"][number]>();
  for (const finding of findings) {
    const key = [finding.file, finding.line, finding.issue.trim().toLowerCase()].join("\0");
    if (!unique.has(key)) unique.set(key, finding);
  }
  return { review: { findings: [...unique.values()] }, failures };
}
