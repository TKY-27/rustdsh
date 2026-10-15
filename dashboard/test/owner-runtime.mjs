import fs from "node:fs/promises";
import path from "node:path";

// runtime.json keeps the MCP token and connection facts; the owner browser
// credential lives in owner-credentials.json (see private-runtime.mjs).
// Tests that drive both the browser and MCP APIs merge the two files.
export async function readRuntime(directory) {
  const runtime = JSON.parse(
    await fs.readFile(path.join(directory, "runtime.json"), "utf8"),
  );
  const owner = JSON.parse(
    await fs.readFile(path.join(directory, "owner-credentials.json"), "utf8"),
  );
  // runtime.json no longer carries the administrator token; keep the historical
  // `token` name so existing fixture code keeps working.
  return { ...runtime, ...owner, token: owner.admin_token };
}
