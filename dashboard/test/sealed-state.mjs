import fs from "node:fs/promises";
import path from "node:path";
import { resealStoredState } from "../state.mjs";

// Fixtures that write state.json directly must keep the stored HMAC seal
// valid: production commits through ProjectStore, so a stale or missing
// state_auth is refused on the next open. Re-sign with the project's own key
// (a no-op for legacy fixtures that never carried a seal).
export async function writeSealedState(project, value) {
  const sealed = await resealStoredState(project, structuredClone(value));
  await fs.mkdir(project.directory, { recursive: true });
  await fs.writeFile(
    path.join(project.directory, "state.json"),
    JSON.stringify(sealed),
  );
  return sealed;
}
