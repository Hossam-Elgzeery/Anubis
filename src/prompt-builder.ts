import { readFile } from "node:fs/promises";

const TEMPLATE_URL = new URL("../prompts/code-review.md", import.meta.url);

export async function buildReviewPrompt(
  reviewContext: string,
  eslintResults: unknown,
  reviewRules: string,
): Promise<string> {
  const template = await readFile(TEMPLATE_URL, "utf8");
  if (!template.trim()) throw new Error("Anubis review prompt template is empty");
  if (
    !template.includes("{{REVIEW_RULES}}") ||
    !template.includes("{{REVIEW_CONTEXT}}") ||
    !template.includes("{{ESLINT_RESULTS}}")
  )
    throw new Error("Anubis review prompt template is missing placeholders");
  return template
    .replace("{{REVIEW_RULES}}", () => reviewRules)
    .replace("{{REVIEW_CONTEXT}}", () => reviewContext)
    .replace("{{ESLINT_RESULTS}}", () => JSON.stringify(eslintResults));
}
