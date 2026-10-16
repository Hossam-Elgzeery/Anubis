import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_CONFIG, saveConfig } from "./config.js";
import type { AnubisConfig } from "./config.js";
import { downloadRecommendedModel } from "./model-downloader.js";
import { RECOMMENDED_MODEL } from "./model.js";

function resolveModelPath(input: string, cwd: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(cwd, trimmed);
}

async function validateModelPath(path: string): Promise<string | null> {
  if (!path.toLowerCase().endsWith(".gguf"))
    return "Model must be a .gguf file.";
  try {
    const info = await stat(path);
    if (!info.isFile()) return "Model path must point to a file.";
    return null;
  } catch {
    return "Model file not found. Check the path and try again.";
  }
}

export async function initializeAnubis(
  cwd = process.cwd(),
): Promise<AnubisConfig> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "Interactive setup requires a terminal. Run 'anubis init' before using Anubis in CI.",
    );
  }

  console.log("\n⚖️ Anubis Initial Setup\n");
  const rl = createInterface({ input: stdin, output: stdout });

  async function ask(label: string, fallback?: string): Promise<string> {
    const suffix = fallback !== undefined ? ` (${fallback})` : "";
    const answer = await rl.question(`${label}${suffix}: `);
    return answer.trim() || fallback || "";
  }

  async function askNumber(
    label: string,
    fallback: number,
    min: number,
    max: number,
    integer = false,
  ): Promise<number> {
    while (true) {
      const value = Number(await ask(label, String(fallback)));
      if (
        Number.isFinite(value) &&
        value >= min &&
        value <= max &&
        (!integer || Number.isInteger(value))
      )
        return value;
      console.log(`⚠️ Enter a valid number between ${min} and ${max}.`);
    }
  }

  try {
    console.log("Choose your AI model:");
    console.log(
      `  1. Download ${RECOMMENDED_MODEL.name} ${RECOMMENDED_MODEL.quantization} (Recommended)`,
    );
    console.log("  2. Use an existing local model\n");

    let choice = "";
    while (choice !== "1" && choice !== "2") {
      choice = await ask("Select an option", "1");
      if (choice !== "1" && choice !== "2") console.log("⚠️ Choose 1 or 2.");
    }

    let modelPath = "";
    if (choice === "1") {
      console.log("\nThe recommended model is a multi-gigabyte download.");
      console.log(`Source: ${RECOMMENDED_MODEL.url}`);
      const confirmation = (
        await ask("Download or reuse this model? [Y/n]", "Y")
      ).toLowerCase();
      if (confirmation !== "y" && confirmation !== "yes") {
        throw new Error("Setup cancelled. No configuration was created.");
      }
      modelPath = await downloadRecommendedModel();
    } else {
      while (!modelPath) {
        const answer = await ask(
          "Enter the absolute or relative path to your GGUF model",
        );
        if (!answer) {
          console.log("⚠️ Model path is required.");
          continue;
        }
        const candidate = resolveModelPath(answer, cwd);
        const error = await validateModelPath(candidate);
        if (error) {
          console.log(`⚠️ ${error}`);
          continue;
        }
        modelPath = candidate;
      }
    }

    console.log(`\n✔ Model ready: ${modelPath}\n`);
    const contextSize = await askNumber(
      "Context size",
      DEFAULT_CONFIG.contextSize,
      1024,
      131072,
      true,
    );
    const temperature = await askNumber(
      "Temperature",
      DEFAULT_CONFIG.temperature,
      0,
      2,
    );
    const maxTokens = await askNumber(
      "Max output tokens",
      Math.min(DEFAULT_CONFIG.maxTokens, contextSize - 1),
      1,
      contextSize - 1,
      true,
    );

    console.log("\nChoose thinking mode:");
    console.log("  1. Auto (Default)");
    console.log("  2. Bounded");
    console.log("  3. Unbounded");
    console.log("  4. Zero thinking budget");

    const thinkingModes = ["auto", "bounded", "unbounded", "zero"] as const;

    let thinkingChoice = "";

    while (!["1", "2", "3", "4"].includes(thinkingChoice)) {
      thinkingChoice = await ask("Select an option", "1");

      if (!["1", "2", "3", "4"].includes(thinkingChoice)) {
        console.log("⚠️ Choose a number between 1 and 4.");
      }
    }

    const thinkingMode = thinkingModes[Number(thinkingChoice) - 1];

    const thoughtTokens =
      thinkingMode === "bounded"
        ? await askNumber(
            "Thinking token budget",
            Math.min(DEFAULT_CONFIG.thoughtTokens, maxTokens),
            1,
            maxTokens,
            true,
          )
        : DEFAULT_CONFIG.thoughtTokens;

    let output = "";
    while (!output) {
      output = await ask("Report filename", DEFAULT_CONFIG.output);
      if (!output.toLowerCase().endsWith(".md")) {
        console.log("⚠️ Report filename must end with .md.");
        output = "";
      }
    }

    const config: AnubisConfig = {
      model: {
        path: modelPath,
        contextSize,
        temperature,
        maxTokens,
        thinkingMode,
        thoughtTokens,
      },
      review: { output },
    };

    const savedPath = await saveConfig(config, cwd);
    console.log("\n✅ Anubis initialized successfully!");
    console.log(`📄 Configuration: ${savedPath}`);
    console.log("\nRun 'anubis check' to review your changes.\n");
    return config;
  } finally {
    rl.close();
  }
}
