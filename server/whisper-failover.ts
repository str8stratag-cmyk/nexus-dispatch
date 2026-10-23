/**
 * Resolves which Whisper base URL the app should talk to right now.
 *
 * Config (desk .env): WHISPER_REMOTE_URL (server-side, preferred) or
 * VITE_WHISPER_SERVICE_URL (legacy/client-facing) names the configured
 * Whisper. If that host is 127.0.0.1/localhost, Whisper is purely local and
 * nothing here applies — every call resolves straight to it, same as before
 * this module existed.
 *
 * If the configured host is remote, scripts/watchdog.ps1 owns the
 * remote-vs-local decision (health-checks the remote, fails a desk over to
 * a local Whisper after a sustained outage, fails back once the remote has
 * been healthy again for a while) and records its current decision in a
 * small JSON state file. This module just reads that file so server/whisper.ts
 * and the /api/whisper proxy (server/whisper-proxy.ts) send requests to
 * whichever side the watchdog says is live, without the browser needing to
 * know (its Whisper URL is baked in at Vite build time and can't change).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_LOCAL_WHISPER_URL = "http://127.0.0.1:8178";

export interface WhisperRuntimeState {
  mode: "remote" | "local";
  remoteUrl: string;
  localUrl: string;
}

export function resolveConfiguredWhisperUrl(env: NodeJS.ProcessEnv = process.env): string {
  const remote = env.WHISPER_REMOTE_URL?.trim();
  if (remote) return remote;
  const vite = env.VITE_WHISPER_SERVICE_URL?.trim();
  if (vite) return vite;
  return DEFAULT_LOCAL_WHISPER_URL;
}

// Malformed URLs resolve "local" (never silently treat garbage config as a
// configured remote with no local fallback ever managed).
export function isLocalWhisperUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return true;
  }
}

function defaultStatePath(): string {
  return join(process.cwd(), "logs", "whisper-runtime-state.json");
}

// Cached briefly so a burst of proxied requests (one per capture chunk)
// doesn't stat/read the state file every time; short enough that a
// watchdog-driven failover takes effect within one capture cycle.
const STATE_CACHE_MS = 2000;
let cache: { state: WhisperRuntimeState | null; readAt: number; path: string } | null = null;

export function readWhisperRuntimeState(statePath: string = defaultStatePath()): WhisperRuntimeState | null {
  const now = Date.now();
  if (cache && cache.path === statePath && now - cache.readAt < STATE_CACHE_MS) {
    return cache.state;
  }
  let state: WhisperRuntimeState | null = null;
  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.mode === "remote" || parsed.mode === "local") &&
        typeof parsed.remoteUrl === "string" && typeof parsed.localUrl === "string") {
      state = { mode: parsed.mode, remoteUrl: parsed.remoteUrl, localUrl: parsed.localUrl };
    }
  } catch {
    // Missing/unreadable/corrupt: no state yet (e.g. watchdog hasn't run on
    // this desk, or this is a fresh checkout) — caller falls back to the
    // configured URL below.
  }
  cache = { state, readAt: now, path: statePath };
  return state;
}

/** Test-only: force the next read to hit disk again. */
export function resetWhisperRuntimeStateCache(): void {
  cache = null;
}

/**
 * The base URL to actually send a Whisper request to right now.
 * - Configured locally: always the configured (local) URL; the runtime
 *   state file is never consulted (today's behavior, unchanged).
 * - Configured remotely: the watchdog's current mode, read from the state
 *   file; defaults to the configured remote URL when no state has been
 *   written yet (e.g. watchdog hasn't run), so a freshly provisioned remote
 *   desk works before its first watchdog health-check cycle completes.
 */
export function resolveWhisperTarget(
  env: NodeJS.ProcessEnv = process.env,
  statePath?: string
): string {
  const configured = resolveConfiguredWhisperUrl(env);
  if (isLocalWhisperUrl(configured)) return configured;
  const state = readWhisperRuntimeState(statePath);
  if (state?.mode === "local") return state.localUrl || DEFAULT_LOCAL_WHISPER_URL;
  return state?.remoteUrl || configured;
}
