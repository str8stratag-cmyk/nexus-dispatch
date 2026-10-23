/**
 * Pure-helper tests for the Whisper GPU failover config/state resolution
 * (server/whisper-failover.ts). The watchdog (scripts/watchdog.ps1) owns the
 * actual health-check/failover decision and writes the runtime-state file
 * this module reads; see trial/test-watchdog-whisper-failover.ps1 for that
 * side. This file covers what the Node app does with it.
 * Run: npx tsx trial/test-whisper-failover.ts
 */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveConfiguredWhisperUrl,
  isLocalWhisperUrl,
  readWhisperRuntimeState,
  resetWhisperRuntimeStateCache,
  resolveWhisperTarget,
  DEFAULT_LOCAL_WHISPER_URL,
} from "../server/whisper-failover";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log("FAIL:", label, "| got:", got, "| want:", want); } else console.log("ok  :", label);
}

// ---- resolveConfiguredWhisperUrl: precedence ----
check("no env vars -> local default", resolveConfiguredWhisperUrl({}), DEFAULT_LOCAL_WHISPER_URL);
check(
  "VITE_WHISPER_SERVICE_URL only -> used",
  resolveConfiguredWhisperUrl({ VITE_WHISPER_SERVICE_URL: "http://192.168.6.103:8178" }),
  "http://192.168.6.103:8178"
);
check(
  "WHISPER_REMOTE_URL takes precedence over VITE_WHISPER_SERVICE_URL",
  resolveConfiguredWhisperUrl({
    WHISPER_REMOTE_URL: "http://192.168.6.103:8178",
    VITE_WHISPER_SERVICE_URL: "http://127.0.0.1:8178",
  }),
  "http://192.168.6.103:8178"
);
check(
  "blank WHISPER_REMOTE_URL falls through to VITE_WHISPER_SERVICE_URL",
  resolveConfiguredWhisperUrl({ WHISPER_REMOTE_URL: "   ", VITE_WHISPER_SERVICE_URL: "http://192.168.6.103:8178" }),
  "http://192.168.6.103:8178"
);

// ---- isLocalWhisperUrl ----
check("127.0.0.1 is local", isLocalWhisperUrl("http://127.0.0.1:8178"), true);
check("localhost is local", isLocalWhisperUrl("http://localhost:8178"), true);
check("::1 is local", isLocalWhisperUrl("http://[::1]:8178"), true);
check("LAN IP is remote", isLocalWhisperUrl("http://192.168.6.103:8178"), false);
check("hostname is remote", isLocalWhisperUrl("http://whisp-1.local:8178"), false);
check("malformed URL treated as local (never silently 'remote')", isLocalWhisperUrl("not a url"), true);

// ---- readWhisperRuntimeState / resolveWhisperTarget ----
const tmp = mkdtempSync(join(tmpdir(), "whisper-failover-test-"));
const statePath = join(tmp, "whisper-runtime-state.json");

check("missing state file -> null", readWhisperRuntimeState(statePath), null);

writeFileSync(statePath, JSON.stringify({ mode: "local", remoteUrl: "http://192.168.6.103:8178", localUrl: "http://127.0.0.1:8178" }));
resetWhisperRuntimeStateCache();
check("valid state file -> parsed", readWhisperRuntimeState(statePath), {
  mode: "local", remoteUrl: "http://192.168.6.103:8178", localUrl: "http://127.0.0.1:8178",
});

writeFileSync(statePath, "{ not json");
resetWhisperRuntimeStateCache();
check("corrupt state file -> null, no throw", readWhisperRuntimeState(statePath), null);

writeFileSync(statePath, JSON.stringify({ mode: "sideways", remoteUrl: "x", localUrl: "y" }));
resetWhisperRuntimeStateCache();
check("invalid mode value -> null", readWhisperRuntimeState(statePath), null);

// resolveWhisperTarget: configured locally -> always local, state file ignored entirely.
writeFileSync(statePath, JSON.stringify({ mode: "local", remoteUrl: "http://192.168.6.103:8178", localUrl: "http://127.0.0.1:8178" }));
resetWhisperRuntimeStateCache();
check(
  "configured local: resolves to configured URL regardless of state file",
  resolveWhisperTarget({}, statePath),
  DEFAULT_LOCAL_WHISPER_URL
);

// resolveWhisperTarget: configured remotely, no state file yet -> configured remote (fail open to config).
resetWhisperRuntimeStateCache();
const noStatePath = join(tmp, "nope.json");
check(
  "configured remote, no state file yet -> configured remote URL",
  resolveWhisperTarget({ WHISPER_REMOTE_URL: "http://192.168.6.103:8178" }, noStatePath),
  "http://192.168.6.103:8178"
);

// resolveWhisperTarget: configured remotely, state says local (watchdog failed over).
check(
  "configured remote, state mode=local -> local URL",
  resolveWhisperTarget({ WHISPER_REMOTE_URL: "http://192.168.6.103:8178" }, statePath),
  "http://127.0.0.1:8178"
);

writeFileSync(statePath, JSON.stringify({ mode: "remote", remoteUrl: "http://192.168.6.103:8178", localUrl: "http://127.0.0.1:8178" }));
resetWhisperRuntimeStateCache();
check(
  "configured remote, state mode=remote -> remote URL",
  resolveWhisperTarget({ WHISPER_REMOTE_URL: "http://192.168.6.103:8178" }, statePath),
  "http://192.168.6.103:8178"
);

// Cache: a read within the TTL window must not pick up a same-tick file
// change without resetWhisperRuntimeStateCache() (covered above); a
// different statePath must never return another path's cached value.
const otherStatePath = join(tmp, "other-state.json");
writeFileSync(otherStatePath, JSON.stringify({ mode: "local", remoteUrl: "a", localUrl: "b" }));
check("different state path -> its own value, not the other path's cache", readWhisperRuntimeState(otherStatePath), {
  mode: "local", remoteUrl: "a", localUrl: "b",
});
check("original state path still reads its own (cached) value", readWhisperRuntimeState(statePath), {
  mode: "remote", remoteUrl: "http://192.168.6.103:8178", localUrl: "http://127.0.0.1:8178",
});

rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
