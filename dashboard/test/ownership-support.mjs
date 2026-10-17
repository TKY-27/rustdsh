import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// These fixtures exercise actual native children, not a simulated successful
// protocol. Missing Linux delegation/native packages must fail on a supported OS.
export const hasOwnershipBackend = ["linux", "win32"].includes(
  process.platform,
);
export const requiresOwnershipBackend = {
  skip: hasOwnershipBackend
    ? false
    : `${process.platform} has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job`,
};
// Read-only birth/scope identity has its own platform support, independent of
// whether the caller can acquire a writable kernel group.
export const hasProcessIdentity = ["linux", "win32", "darwin"].includes(process.platform);
export const requiresProcessIdentity = {
  skip: hasProcessIdentity
    ? false
    : `${process.platform} has no process identity reader; positive Tunnel identity fixtures require Linux, Windows or Darwin`,
};

// The Colima acceptance fixtures need the transport the runtime accepts
// (dashboard/process-scope.mjs colimaTransport and its version check): the
// colima context must point at ~/.colima/default/docker.sock, report an engine
// ID and run a Linux server. Anything else would only fail with
// ownership_unavailable, so it skips instead.
function colimaReachable() {
  if (process.platform !== "darwin") return false;
  const docker = ["/opt/homebrew/bin/docker", "/usr/local/bin/docker"].find(
    (candidate) => existsSync(candidate),
  );
  if (!docker) return false;
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith("DOCKER_")) delete environment[key];
  const run = (args) => {
    const result = spawnSync(docker, args, {
      env: environment,
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  let expected;
  try {
    expected =
      "unix://" +
      path.join(realpathSync(os.homedir()), ".colima", "default", "docker.sock");
  } catch {
    return false;
  }
  const endpoint = run([
    "--context", "colima", "context", "inspect", "colima",
    "--format", "{{.Endpoints.docker.Host}}",
  ]);
  if (endpoint !== expected) return false;
  const engine = run(["--host", expected, "info", "--format", "{{.ID}}"]);
  if (!engine || !/^[a-zA-Z0-9._-]{1,256}$/.test(engine)) return false;
  const server = run([
    "--host", expected, "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}",
  ]);
  return Boolean(server && /^linux\/[a-z0-9_/-]+$/.test(server));
}
export const hasColima = colimaReachable();
export const requiresColima = {
  skip:
    process.platform !== "darwin"
      ? "requires the macOS Colima Docker context"
      : hasColima
        ? false
        : "requires a running default Colima context (colima start)",
};
// The GPU ledger lock binds Linux flock and the Windows file APIs only
// (dashboard/gpu-lock.mjs); other platforms report gpu_lock_platform_unsupported.
export const hasGpuLock = ["linux", "win32"].includes(process.platform);
export const requiresGpuLock = {
  skip: hasGpuLock
    ? false
    : `${process.platform} has no GPU lock binding; GPU leases require Linux flock or the Windows file lock`,
};
