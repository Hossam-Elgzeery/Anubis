import { readFile } from "node:fs/promises";

export async function loadReviewRules(): Promise<string> {
  const rules = await readFile(
    new URL("../rules/react-native.md", import.meta.url),
    "utf8",
  );
  if (!rules.trim()) throw new Error("React Native review rules are empty");
  return rules;
}
