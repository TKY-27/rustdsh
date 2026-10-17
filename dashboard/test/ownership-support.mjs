import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

// Darwin owned scopes run in Colima Docker containers, so their fixtures need
// a reachable Colima context; without one the runtime reports
// ownership_unavailable by design rather than a test failure.
function colimaReachable() {
  if (process.platform !== "darwin") return false;
  const docker = ["/opt/homebrew/bin/docker", "/usr/local/bin/docker"].find(
    (candidate) => existsSync(candidate),
  );
  if (!docker) return false;
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith("DOCKER_")) delete environment[key];
  return (
    spawnSync(docker, ["--context", "colima", "info", "--format", "{{.ID}}"], {
      env: environment,
      stdio: "ignore",
      timeout: 5000,
    }).status === 0
  );
}
export const hasColima = colimaReachable();
export const requiresColima = {
  skip:
    process.platform !== "darwin"
      ? "requires the macOS Colima Docker context"
      : hasColima
        ? false
        : "requires a running Colima Docker context (colima start)",
};
// Owned-scope fixtures run wherever the runtime can acquire an owned scope:
// Linux and Windows natively, Darwin through a running Colima context.
export const requiresOwnedScope = {
  skip:
    hasOwnershipBackend || hasColima
      ? false
      : process.platform === "darwin"
        ? "darwin owned scopes run in Colima Docker; requires a running Colima context (colima start)"
        : `${process.platform} has no owned process-scope backend`,
};
// The GPU ledger lock binds Linux flock and the Windows file APIs only
// (dashboard/gpu-lock.mjs); other platforms report gpu_lock_platform_unsupported.
export const hasGpuLock = ["linux", "win32"].includes(process.platform);
export const requiresGpuLock = {
  skip: hasGpuLock
    ? false
    : `${process.platform} has no GPU lock binding; GPU leases require Linux flock or the Windows file lock`,
};
