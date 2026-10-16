import { homedir } from "node:os";
import { join } from "node:path";

export const RECOMMENDED_MODEL = {
  name: "Qwen3.5-4B",
  quantization: "Q6_K",
  filename: "Qwen3.5-4B-Q6_K.gguf",
  url: "https://huggingface.co/lmstudio-community/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q6_K.gguf",
  // Checksum must be verified against the exact Hugging Face file before release.
  sha256: "12a6d0136484ecbd85f91860924b1bf571da66e2cebfa507522efc01f9b7d1d9",
  directory: join(homedir(), ".anubis", "models"),
} as const;
