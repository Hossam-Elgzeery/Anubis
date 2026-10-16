import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { z } from "zod";

import type { AnubisConfig } from "./config.js";
import { parseAIReview } from "./parse-review.js";
import { buildReviewPrompt } from "./prompt-builder.js";
import type { ReviewChunk } from "./git.js";
import type { StaticIssue } from "./eslint.js";

export const reviewSchema = z.object({
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().min(1),
      severity: z.enum(["critical", "high", "medium", "low"]),
      issue: z.string(),
      impact: z.string(),
      suggestion: z.string(),
    }),
  ),
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
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
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
): Promise<AIReviewResult> {
  const validated: AIReviewResult["findings"] = [];
  const lineCounts = new Map<string, number>();

  for (const finding of result.findings) {
    const file = finding.file;
    const absolute = resolve(cwd, file);
    const relativePath = relative(cwd, absolute);

    if (
      !file ||
      isAbsolute(file) ||
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      relativePath.startsWith("..\\") ||
      !/\.(js|jsx|ts|tsx)$/i.test(file)
    ) {
      if (process.env.ANUBIS_DEBUG === "1") {
        console.warn(`⚠️ Dropping AI finding with invalid file path: ${file}`);
      }
      continue;
    }

    let lineCount = lineCounts.get(absolute);

    if (lineCount === undefined) {
      try {
        const content = await readFile(absolute, "utf8");
        lineCount = content.split(/\r?\n/).length;
        lineCounts.set(absolute, lineCount);
      } catch {
        if (process.env.ANUBIS_DEBUG === "1") {
          console.warn(`⚠️ Dropping AI finding for missing file: ${file}`);
        }
        continue;
      }
    }

    if (finding.line < 1 || finding.line > lineCount) {
      if (process.env.ANUBIS_DEBUG === "1") {
        console.warn(
          `⚠️ Dropping AI finding with out-of-range location: ${file}:${finding.line}`,
        );
      }
      continue;
    }

    validated.push(finding);
  }

  return { findings: validated };
}

/**
 * node-llama-cpp reasoning budgets control thought segments, not the GGUF
 * chat template's enable_thinking switch. In particular, zero is NOT a
 * guaranteed non-thinking mode. No model-specific wrapper is forced here.
 */
function resolveThoughtBudget(config: AnubisConfig): number | undefined {
  const mode = config.model.thinkingMode;
  if (mode === "unbounded") return undefined;
  if (mode === "zero") return 0;
  if (mode === "bounded") return config.model.thoughtTokens;

  // Auto only applies a cap to the Qwen3 family, which can consume the
  // entire generation budget in thought. Other models retain SDK behavior.
  if (/qwen[\s._-]*3/i.test(config.model.path)) {
    return Math.min(config.model.thoughtTokens, Math.max(1, config.model.maxTokens - 256));
  }
  return undefined;
}

/** A failed chunk is not silently converted into an empty review. */
export interface ChunkReviewResult {
  review: AIReviewResult;
  failures: Array<{ file: string; startLine: number; endLine: number; reason: string }>;
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
  console.log(`🧠 Thinking strategy: ${config.model.thinkingMode}` +
    (thoughtBudget === undefined ? " (SDK default)" : ` (${thoughtBudget} thought tokens)`));
  if (config.model.thinkingMode === "zero") {
    console.warn("⚠️ Zero thought budget does not guarantee that the model's thinking mode is disabled.");
  }
  const grammar = await llama.createGrammarForJsonSchema(reviewJsonSchema);

  try {
    for (const [index, chunk] of chunks.entries()) {
      console.log(`\n🧩 Reviewing chunk ${index + 1}/${chunks.length}: ${chunk.file}:${chunk.ownedStartLine}-${chunk.ownedEndLine}`);
      const relevantESLint = eslintResults.filter((issue) =>
        issue.file === chunk.file &&
        issue.line >= chunk.ownedStartLine &&
        issue.line <= chunk.ownedEndLine,
      );
      const prompt = await buildReviewPrompt(chunk.context, relevantESLint);
      let firstError: unknown;
      let completed = false;

      for (const useGrammar of [true, false]) {
        let context: Awaited<ReturnType<typeof model.createContext>> | undefined;
        try {
          context = await model.createContext({ contextSize: config.model.contextSize });
          const session = new LlamaChatSession({
            contextSequence: context.getSequence(), systemPrompt: rules,
          });
          let mainTokens = 0;
          let allChunkTokens = 0;
          const segmentTypes = new Set<string>();
          const thoughtChunks: string[] = [];
          const started = performance.now();
          const result = await session.promptWithMeta(prompt, {
            temperature: config.model.temperature,
            maxTokens: config.model.maxTokens,
            ...(thoughtBudget === undefined ? {} : { budgets: { thoughtTokens: thoughtBudget } }),
            ...(useGrammar ? { grammar } : {}),
            onToken: (tokens) => { mainTokens += tokens.length; },
            onResponseChunk: (part) => {
              allChunkTokens += part.tokens.length;
              if (part.segmentType) segmentTypes.add(part.segmentType);
              if (debug && part.segmentType === "thought" && part.text) {
                thoughtChunks.push(part.text);
              }
            },
          });
          if (debug) {
            console.log(`\n🧠 Raw AI Response (${useGrammar ? "grammar" : "fallback"}):`, result.responseText);
            console.log("🛑 Stop reason:", result.stopReason);
            console.log("🧮 Main response tokens:", mainTokens);
            console.log("🧮 All streamed tokens:", allChunkTokens);
            console.log("🧠 Segment types:", [...segmentTypes]);
            console.log("📚 Context size:", config.model.contextSize);
            console.log("⏱️ Generation duration:", ((performance.now() - started) / 1000).toFixed(1), "seconds");
            console.log("🧠 Thought preview:", thoughtChunks.join("").slice(0, 3000));
          }
          const parsed = reviewSchema.parse(parseAIReview(result.responseText));
          const validated = await validateFindingLocations(parsed);
          // Discard hallucinated files and findings from overlap/context lines.
          const owned = validated.findings.filter((finding) =>
            finding.file === chunk.file &&
            finding.line >= chunk.ownedStartLine &&
            finding.line <= chunk.ownedEndLine,
          );
          findings.push(...owned);
          completed = true;
          console.log(`✔ Chunk reviewed: ${owned.length} findings`);
          break;
        } catch (error) {
          if (useGrammar) {
            firstError = error;
            console.warn("⚠️ Structured output failed; retrying without grammar.");
            if (debug) console.warn(error);
          } else {
            const message = error instanceof Error ? error.message : String(error);
            const initial = firstError instanceof Error ? firstError.message : String(firstError);
            failures.push({
              file: chunk.file, startLine: chunk.ownedStartLine,
              endLine: chunk.ownedEndLine,
              reason: `Grammar: ${initial}; Fallback: ${message}`,
            });
            console.warn(`⚠️ Chunk review failed: ${chunk.file}:${chunk.ownedStartLine}-${chunk.ownedEndLine}`);
          }
        } finally {
          await context?.dispose();
        }
      }
      if (!completed && debug) console.warn("⚠️ Chunk has no completed AI review.");
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
