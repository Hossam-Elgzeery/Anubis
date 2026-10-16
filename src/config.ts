import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = "anubis.config.json";

export const DEFAULT_CONFIG = {
  contextSize: 8192,
  temperature: 0,
  maxTokens: 3072,
  thinkingMode: "auto",
  thoughtTokens: 1024,
  output: "ANUBIS_REPORT.md",
} as const;

const configSchema = z.object({
  model: z.object({
    path: z.string().min(1, "Model path is required"),
    contextSize: z.number().int().min(1024).default(DEFAULT_CONFIG.contextSize),
    temperature: z.number().min(0).max(2).default(DEFAULT_CONFIG.temperature),
    maxTokens: z.number().int().positive().default(DEFAULT_CONFIG.maxTokens),
    // auto: bounded for Qwen thinking models; leave other models unchanged.
    // bounded: explicit reasoning budget; unbounded: SDK default budget.
    // zero: request zero thought tokens (not guaranteed to disable model thinking).
    thinkingMode: z.enum(["auto", "bounded", "unbounded", "zero"])
      .default(DEFAULT_CONFIG.thinkingMode),
    thoughtTokens: z.number().int().positive()
      .default(DEFAULT_CONFIG.thoughtTokens),
  }),
  review: z
    .object({
      output: z.string().min(1).default(DEFAULT_CONFIG.output),
    })
    .default({ output: DEFAULT_CONFIG.output }),
});

export type AnubisConfig = z.infer<typeof configSchema>;

function validateConfig(config: AnubisConfig): void {
  if (config.model.maxTokens >= config.model.contextSize) {
    throw new Error("maxTokens must be smaller than contextSize.");
  }
}

export async function configExists(cwd = process.cwd()): Promise<boolean> {
  const configPath = resolve(cwd, CONFIG_FILENAME);

  try {
    await readFile(configPath, "utf8");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function loadConfig(cwd = process.cwd()): Promise<AnubisConfig> {
  const configPath = resolve(cwd, CONFIG_FILENAME);

  const content = await readFile(configPath, "utf8");
  const config = configSchema.parse(JSON.parse(content));

  validateConfig(config);

  return {
    ...config,
    model: {
      ...config.model,
      path: resolve(cwd, config.model.path),
    },
  };
}

export async function saveConfig(
  config: AnubisConfig,
  cwd = process.cwd(),
): Promise<string> {
  const validated = configSchema.parse(config);
  validateConfig(validated);

  const configPath = resolve(cwd, CONFIG_FILENAME);

  await writeFile(configPath, JSON.stringify(validated, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  });

  return configPath;
}
