import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function renameRuntimeFile(from, to) {
  if (process.platform !== "win32") return fs.rename(from, to);
  const deadline = performance.now() + 50;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (error) {
      const wait = 2 ** attempt;
      // Runtime readers may briefly block replacement; never unlink the target.
      if (error.code !== "EPERM" || attempt >= 5 || performance.now() + wait >= deadline)
        throw error;
      await delay(wait);
      if (performance.now() >= deadline) throw error;
    }
  }
}
