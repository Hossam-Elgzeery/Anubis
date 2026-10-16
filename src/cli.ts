#!/usr/bin/env node

import { Command } from "commander";

import { configExists, loadConfig } from "./config.js";
import type { AnubisConfig } from "./config.js";

import { initializeAnubis } from "./init.js";
import { getChangedFiles, getReviewChunks } from "./git.js";
import { runESLint } from "./eslint.js";
import { loadReviewRules } from "./rules.js";
import { runAIReview } from "./llm.js";
import type { AIReviewResult } from "./llm.js";
import { generateReport } from "./reporter.js";

const program = new Command();

program
  .name("anubis")
  .description("100% Local AI Code Reviewer for React Native")
  .version("0.1.0");

// Keep CLI help aligned with the branding and commands in README.md.
program.addHelpText(
  "beforeAll",
  `\n⚖️ ANUBIS
Before the Merge Comes the Judgment.

AI-Powered Code Review · 100% Local · Built for React Native\n`,
);

program.addHelpText(
  "afterAll",
  `\nExamples:
  $ anubis init
  $ anubis check
  $ ANUBIS_DEBUG=1 anubis check

How Anubis Works:
  🌿 Detects staged, unstaged, and untracked JS/TS changes
  🔍 Runs ESLint static analysis
  🧠 Reviews changes with local AI
  📊 Generates an actionable Markdown report

🔒 Your code stays on your machine during review.\n`,
);

function printError(error: unknown): void {
  console.error(
    "\n❌ Anubis failed:",
    error instanceof Error ? error.message : String(error),
  );

  process.exitCode = 1;
}

async function getOrInitializeConfig(cwd: string): Promise<AnubisConfig> {
  if (await configExists(cwd)) {
    console.log("⚙️ Loading Anubis configuration...");
    return loadConfig(cwd);
  }

  console.log("⚙️ No Anubis configuration found.");
  console.log("🚀 Starting initial setup...");

  return initializeAnubis(cwd);
}

program
  .command("init")
  .description("Set up Anubis in the current project")
  .action(async () => {
    const cwd = process.cwd();

    try {
      if (await configExists(cwd)) {
        console.log("\nℹ️ Anubis is already initialized.");
        console.log("Configuration: anubis.config.json");
        console.log("Remove or rename it to initialize again.\n");
        return;
      }

      await initializeAnubis(cwd);
    } catch (error) {
      printError(error);
    }
  });

program
  .command("check")
  .description("Review Git changes using ESLint and local AI")
  .action(async () => {
    const cwd = process.cwd();

    console.log("\n⚖️ Anubis Code Review\n");

    try {
      const config = await getOrInitializeConfig(cwd);

      console.log(`✔ Model: ${config.model.path}`);

      console.log("\n📂 Detecting Git changes...");

      const files = await getChangedFiles(cwd);

      console.log(`✔ Found ${files.length} changed JS/TS files`);

      for (const file of files) {
        console.log(`  📄 ${file}`);
      }

      if (files.length === 0) {
        console.log("\nℹ️ No changed files to review.");
        return;
      }

      console.log("\n🔍 Running static analysis...");

      const eslintResult = await runESLint(files, cwd);

      console.log(
        eslintResult.source === "project"
          ? "✔ Using project ESLint configuration"
          : "✔ Using Anubis default ESLint rules",
      );

      if (eslintResult.status === "completed") {
        const errors = eslintResult.issues.filter(
          (issue) => issue.severity === "error",
        ).length;

        const warnings = eslintResult.issues.filter(
          (issue) => issue.severity === "warning",
        ).length;

        console.log("✔ ESLint analysis completed");
        console.log(`  Errors:   ${errors}`);
        console.log(`  Warnings: ${warnings}`);
      } else {
        console.log(`⚠️ ESLint ${eslintResult.status}: ${eslintResult.reason}`);
      }

      console.log("\n📚 Loading React Native review rules...");

      const rules = await loadReviewRules();

      console.log("✔ Review rules loaded");

      console.log("\n📄 Preparing AI review context...");

      const chunks = await getReviewChunks(files, cwd);
      console.log(`✔ Prepared ${chunks.length} review chunks`);
      if (process.env.ANUBIS_DEBUG === "1") {
        for (const [index, chunk] of chunks.entries()) {
          console.log(`\n📄 Review Context ${index + 1}/${chunks.length}:`);
          console.log(chunk.context);
        }
      }

      let aiResult: AIReviewResult = {
        findings: [],
      };

      let aiError: string | undefined;

      try {
        console.log("\n🧠 Starting local AI review...");

        const chunkResult = await runAIReview(
          chunks,
          rules,
          eslintResult.issues,
          config,
        );
        aiResult = chunkResult.review;
        if (chunkResult.failures.length > 0) {
          aiError = `${chunkResult.failures.length}/${chunks.length} AI chunks failed:\n` +
            chunkResult.failures.map((failure) =>
              `${failure.file}:${failure.startLine}-${failure.endLine}: ${failure.reason}`,
            ).join("\n");
          process.exitCode = 1;
          console.warn(`⚠️ AI review partially completed: ${chunkResult.failures.length} failed chunks`);
        }

        if (!aiError) console.log("✔ AI review completed");
        console.log(`✔ Found ${aiResult.findings.length} AI findings`);
      } catch (error) {
        aiError = error instanceof Error ? error.message : String(error);

        console.error(`❌ AI review failed: ${aiError}`);

        process.exitCode = 1;
      }

      console.log("\n📝 Generating Markdown report...");

      const reportPath = await generateReport(
        cwd,
        eslintResult,
        aiResult,
        aiError,
        config.review.output,
      );

      console.log("\n==================================");
      console.log("⚖️ ANUBIS REVIEW SUMMARY");
      console.log("==================================");

      console.log(`Files detected: ${files.length}`);
      console.log(`ESLint issues: ${eslintResult.issues.length}`);
      console.log(`AI findings: ${aiResult.findings.length}`);
      console.log(`AI status: ${aiError ? "Partial / Failed" : "Completed"}`);

      if (aiError) {
        console.log("\n⚠️ Report generated, but AI review failed.");
      } else {
        console.log("\n✅ Report generated successfully!");
      }

      console.log(`📄 ${reportPath}\n`);
    } catch (error) {
      printError(error);
    }
  });

await program.parseAsync(process.argv);
