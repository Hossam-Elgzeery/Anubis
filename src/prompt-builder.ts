import { readFile } from "node:fs/promises";

const TEMPLATE_URL = new URL("../prompts/code-review.md", import.meta.url);

export async function buildReviewPrompt(
  reviewContext: string,
  eslintResults: unknown,
): Promise<string> {
  const template = await readFile(TEMPLATE_URL, "utf8");

  if (!template.trim()) {
    throw new Error("Anubis review prompt template is empty");
  }

  const contextMarker = "{{REVIEW_CONTEXT}}";
  const eslintMarker = "{{ESLINT_RESULTS}}";

  if (!template.includes(contextMarker) || !template.includes(eslintMarker)) {
    throw new Error("Anubis review prompt template is missing placeholders");
  }

  return template
    .replace(contextMarker, () => reviewContext)
    .replace(eslintMarker, () => JSON.stringify(eslintResults));
}
