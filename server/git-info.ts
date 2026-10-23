/**
 * Git branch/commit info for GET /api/health. The real `git` call is
 * isolated behind an injectable exec function so trial tests can simulate
 * success and "git unavailable" without a real repo/binary.
 */
import { execFileSync } from "node:child_process";

export interface GitInfo {
  branch: string | null;
  sha: string | null;
}

export type ExecGit = (args: string[]) => string;

export function runGit(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", timeout: 5000 }).trim();
}

export function computeGitInfo(exec: ExecGit): GitInfo {
  let branch: string | null = null;
  let sha: string | null = null;
  try {
    branch = exec(["rev-parse", "--abbrev-ref", "HEAD"]).trim() || null;
  } catch {
    branch = null;
  }
  try {
    sha = exec(["rev-parse", "--short", "HEAD"]).trim() || null;
  } catch {
    sha = null;
  }
  return { branch, sha };
}

// Branch/sha don't change without a process restart (a pull that updates
// the repo restarts the app -- see scripts/watchdog.ps1 Pull-Repo), so this
// is computed once per process rather than on every /api/health hit.
let cached: GitInfo | null = null;

export function getGitInfo(exec: ExecGit = runGit): GitInfo {
  if (!cached) {
    cached = computeGitInfo(exec);
  }
  return cached;
}

/** Test-only: clear the cache so each case gets a fresh computeGitInfo() call. */
export function resetGitInfoCache(): void {
  cached = null;
}
