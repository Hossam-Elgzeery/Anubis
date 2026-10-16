import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { createRequire } from "node:module";
import { ESLint } from "eslint";
import { defaultESLintConfig } from "./default-eslint.js";

export interface StaticIssue {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  ruleId: string | null;
  message: string;
}

export interface StaticAnalysisResult {
  source: "project" | "anubis";
  status: "completed" | "skipped" | "failed";
  issues: StaticIssue[];
  reason?: string;
}

const configFiles = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];

function hasProjectConfig(cwd: string): boolean {
  let current = cwd;

  while (true) {
    if (configFiles.some((file) => existsSync(join(current, file)))) {
      return true;
    }

    const packagePath = join(current, "package.json");

    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8"));

        if (pkg.eslintConfig) return true;
      } catch {
        // Ignore invalid package metadata during detection
      }
    }

    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function runESLint(
  files: string[],
  cwd: string = process.cwd(),
): Promise<StaticAnalysisResult> {
  const hasConfig = hasProjectConfig(cwd);
  const source = hasConfig ? "project" : "anubis";

  if (files.length === 0) {
    return {
      source,
      status: "skipped",
      issues: [],
      reason: "No changed JS/TS files found",
    };
  }

  try {
    let eslint: ESLint;

    if (hasConfig) {
      const projectRequire = createRequire(join(cwd, "package.json"));

      const eslintPath = projectRequire.resolve("eslint");
      const projectESLint = projectRequire(
        eslintPath,
      ) as typeof import("eslint");

      eslint = new projectESLint.ESLint({ cwd });
    } else {
      eslint = new ESLint({
        cwd,
        overrideConfigFile: true,
        overrideConfig: defaultESLintConfig,
      });
    }

    const results = await eslint.lintFiles(files);

    const issues: StaticIssue[] = results.flatMap((result) =>
      result.messages.map((message) => ({
        file: relative(cwd, result.filePath),
        line: message.line ?? 0,
        column: message.column ?? 0,
        severity: message.severity === 2 ? "error" : "warning",
        ruleId: message.ruleId,
        message: message.message,
      })),
    );

    return {
      source,
      status: "completed",
      issues,
    };
  } catch (error) {
    return {
      source,
      status: "failed",
      issues: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
