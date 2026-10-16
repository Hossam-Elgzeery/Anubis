import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { RECOMMENDED_MODEL } from "./model.js";

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function showProgress(received: number, total: number | undefined): void {
  const mb = (received / 1024 / 1024).toFixed(1);
  if (total && total > 0) {
    const percent = Math.min(100, (received / total) * 100).toFixed(1);
    process.stdout.write(`\r⬇️  Downloading: ${percent}% (${mb} / ${(total / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    process.stdout.write(`\r⬇️  Downloading: ${mb} MB`);
  }
}

export async function downloadRecommendedModel(): Promise<string> {
  const model = RECOMMENDED_MODEL;
  const target = join(model.directory, model.filename);
  await mkdir(model.directory, { recursive: true });

  try {
    const info = await stat(target);
    if (info.isFile()) {
      console.log("🔎 Verifying existing model...");
      if ((await sha256File(target)).toLowerCase() === model.sha256) {
        console.log("✔ Recommended model already downloaded.");
        return target;
      }
      throw new Error(`An existing model failed integrity verification: ${target}. Move or delete it before retrying.`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const temporary = `${target}.${process.pid}.${Date.now()}.part`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let completed = false;
  let lastUpdate = 0;
  try {
    const response = await fetch(model.url, { headers: { "User-Agent": "Anubis-Code-Review" } });
    if (!response.ok || !response.body) {
      throw new Error(`Model download failed (HTTP ${response.status}).`);
    }
    const lengthHeader = response.headers.get("content-length");
    const total = lengthHeader && Number.isFinite(Number(lengthHeader)) ? Number(lengthHeader) : undefined;
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    handle = await open(temporary, "wx");
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          if (bytesWritten === 0) throw new Error("Unable to write downloaded model to disk.");
          offset += bytesWritten;
        }
        received += value.byteLength;
        if (Date.now() - lastUpdate > 250) {
          showProgress(received, total);
          lastUpdate = Date.now();
        }
      }
    } finally {
      reader.releaseLock();
    }
    showProgress(received, total);
    process.stdout.write("\n");
    if (total !== undefined && received !== total) {
      throw new Error(`Incomplete download: expected ${total} bytes, received ${received}.`);
    }
    if (hash.digest("hex").toLowerCase() !== model.sha256) {
      throw new Error("Downloaded model failed SHA-256 verification.");
    }
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    completed = true;
    console.log("✔ Model downloaded and verified.");
    return target;
  } finally {
    if (handle) await handle.close();
    if (!completed) await rm(temporary, { force: true });
  }
}
