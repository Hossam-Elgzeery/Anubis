import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import type { StaticAnalysisResult } from "./eslint.js";
import type { AIReviewResult } from "./llm.js";

const REPORT_IMAGE = "Anubis_Report.png";

const SEVERITY_ICONS: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  error: "🔴",
  warning: "🟡",
};

function severityIcon(severity: string): string {
  return SEVERITY_ICONS[severity.toLowerCase()] ?? "⚪";
}

function createFileLink(
  cwd: string,
  reportPath: string,
  file: string,
  line: number,
): string {
  const safeLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;

  const absolutePath = resolve(cwd, file);
  const projectRelativePath = relative(cwd, absolutePath);

  if (
    isAbsolute(file) ||
    projectRelativePath === ".." ||
    projectRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(projectRelativePath)
  ) {
    return `\`${file}:${safeLine}\``;
  }

  const relativePath = relative(dirname(reportPath), absolutePath);

  const encodedPath = relativePath.split(sep).map(encodeURIComponent).join("/");

  const label = `${basename(file)}:${safeLine}`;

  return `[${label}](<${encodedPath}#L${safeLine}>)`;
}

async function prepareReportImage(reportDirectory: string): Promise<string> {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));

  const sourcePath = resolve(currentDirectory, "..", "assets", REPORT_IMAGE);

  const assetsDirectory = resolve(reportDirectory, ".anubis-assets");

  await mkdir(assetsDirectory, {
    recursive: true,
  });

  const destinationPath = resolve(assetsDirectory, REPORT_IMAGE);

  await copyFile(sourcePath, destinationPath);

  return `.anubis-assets/${REPORT_IMAGE}`;
}

export async function generateReport(
  cwd: string,
  eslint: StaticAnalysisResult,
  ai: AIReviewResult,
  aiError?: string,
  output = "ANUBIS_REPORT.md",
): Promise<string> {
  const reportPath = resolve(cwd, output);
  const reportDirectory = dirname(reportPath);

  await mkdir(reportDirectory, {
    recursive: true,
  });

  const imagePath = await prepareReportImage(reportDirectory);

  const staticErrors = eslint.issues.filter(
    (issue) => issue.severity === "error",
  ).length;

  const staticWarnings = eslint.issues.filter(
    (issue) => issue.severity === "warning",
  ).length;

  const criticalFindings = ai.findings.filter(
    (finding) => finding.severity === "critical",
  ).length;

  const highFindings = ai.findings.filter(
    (finding) => finding.severity === "high",
  ).length;

  const mediumFindings = ai.findings.filter(
    (finding) => finding.severity === "medium",
  ).length;

  const lowFindings = ai.findings.filter(
    (finding) => finding.severity === "low",
  ).length;

  const lines: string[] = [
    '<div align="center">',
    "",
    `<img src="${imagePath}" alt="Anubis Logo" width="200" />`,
    "",
    "# Anubis Report",
    "",
    "*Before the Merge Comes the Judgment.*",
    "",
    "</div>",
    "",
    `**📅 Generated:** ${new Date().toLocaleString("en-US")}`,
    "",
    "---",
    "",
    "## 📊 Review Summary",
    "",
    "| Metric | Result |",
    "| :--- | :--- |",
    `| 🔍 Static Issues | **${eslint.issues.length}** |`,
    `| 🔴 ESLint Errors | ${staticErrors} |`,
    `| 🟡 ESLint Warnings | ${staticWarnings} |`,
    `| 🧠 AI Findings | **${ai.findings.length}** |`,
    `| 🚨 Critical AI Findings | ${criticalFindings} |`,
    `| ⚠️ High AI Findings | ${highFindings} |`,
    `| 🟡 Medium AI Findings | ${mediumFindings} |`,
    `| 🔵 Low AI Findings | ${lowFindings} |`,
    `| 🤖 AI Status | ${aiError ? "❌ Failed" : "✅ Completed"} |`,
    "",
    `**🛠️ ESLint Configuration:** ${eslint.source}`,
    "",
    "---",
    "",
    "## 🔍 Static Analysis",
    "",
  ];

  if (eslint.reason) {
    lines.push(`> ⚠️ ${eslint.reason}`, "");
  }

  if (eslint.issues.length === 0) {
    lines.push("✅ No static analysis issues reported.", "");
  }

  for (const [index, issue] of eslint.issues.entries()) {
    const link = createFileLink(cwd, reportPath, issue.file, issue.line);

    lines.push(
      `### ${severityIcon(issue.severity)} ${index + 1}. ${issue.severity.toUpperCase()}`,
      "",
      `**📍 Location:** ${link}`,
      "",
      `**📏 Rule:** \`${issue.ruleId ?? "Unknown"}\``,
      "",
      "**📝 Description**",
      "",
      issue.message,
      "",
      "---",
      "",
    );
  }

  lines.push("## 🧠 AI Code Review", "");

  if (aiError) {
    lines.push(
      "> ❌ **AI Review Failed**",
      ">",
      "> The AI review could not be completed.",
      "",
      "<details>",
      "<summary>🔎 Error Details</summary>",
      "",
      "```text",
      aiError.replace(/```/g, "'''"),
      "```",
      "",
      "</details>",
      "",
    );
  } else if (ai.findings.length === 0) {
    lines.push("✅ No AI findings reported.", "");
  }

  for (const [index, finding] of ai.findings.entries()) {
    const link = createFileLink(cwd, reportPath, finding.file, finding.line);

    lines.push(
      `### ${severityIcon(finding.severity)} ${index + 1}. ${finding.severity.toUpperCase()}`,
      "",
      `**📍 Location:** ${link}`,
      "",
      "**🐛 Issue**",
      "",
      finding.issue,
      "",
      "**⚠️ Impact**",
      "",
      finding.impact,
      "",
      "**💡 Suggested Fix**",
      "",
      finding.suggestion,
      "",
      "---",
      "",
    );
  }

  lines.push(
    "",
    '<div align="center">',
    "",
    "**⚖️ Anubis — AI-Powered Code Review**",
    "",
    "</div>",
    "",
  );

  const temporaryPath = resolve(
    reportDirectory,
    `.${basename(reportPath)}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, lines.join("\n"), "utf8");
    await rename(temporaryPath, reportPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return reportPath;
}
