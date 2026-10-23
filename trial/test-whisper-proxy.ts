/**
 * Unit test for the /api/whisper/* proxy (server/whisper-proxy.ts): real
 * Express app + two real stub Whisper HTTP servers (one playing "local", one
 * "remote"), no MongoDB/Chrome/watchdog involved. Verifies the proxy
 * forwards to whichever side the runtime-state file says is live, forwards
 * method/body/content-type/API-key, falls back sanely when the state file
 * is missing, and never consults the state file at all for a locally
 * configured desk.
 * Run: npx tsx trial/test-whisper-proxy.ts
 */
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWhisperProxyRoutes } from "../server/whisper-proxy";
import { resetWhisperRuntimeStateCache } from "../server/whisper-failover";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log("FAIL:", label, "| got:", got, "| want:", want); } else console.log("ok  :", label);
}

function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as AddressInfo).port)));
}

// ---- stub Whisper servers: each records every request it received ----
interface Received { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }
function makeStub(label: string, received: Received[]) {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ method: req.method || "", path: req.url || "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ from: label, path: req.url }));
    });
  });
}

const localReceived: Received[] = [];
const remoteReceived: Received[] = [];
const localStub = makeStub("local", localReceived);
const remoteStub = makeStub("remote", remoteReceived);
const localPort = await listen(localStub, "127.0.0.1");
// 127.0.0.2 (not 127.0.0.1/localhost/::1) so isLocalWhisperUrl() correctly
// treats this stub as "remote" -- it's still loopback so the test doesn't
// need real network access, but its URL text exercises the actual
// local-vs-remote branch instead of accidentally short-circuiting on it.
const remotePort = await listen(remoteStub, "127.0.0.2");
const localUrl = `http://127.0.0.1:${localPort}`;
const remoteUrl = `http://127.0.0.2:${remotePort}`;

const tmp = mkdtempSync(join(tmpdir(), "whisper-proxy-test-"));
const statePath = join(tmp, "whisper-runtime-state.json");

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  registerWhisperProxyRoutes(app, { statePath });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const oldApiKey = process.env.WHISPER_API_KEY;
const oldRemote = process.env.WHISPER_REMOTE_URL;
const oldVite = process.env.VITE_WHISPER_SERVICE_URL;

try {
  // ---- configured remote, no state file yet -> forwards to configured remote ----
  process.env.WHISPER_REMOTE_URL = remoteUrl;
  delete process.env.VITE_WHISPER_SERVICE_URL;
  process.env.WHISPER_API_KEY = "test-key-123";

  await withApp(async (base) => {
    const res = await fetch(`${base}/api/whisper/health`);
    const json = await res.json() as { from: string };
    check("no state file: GET /health forwarded to remote", json.from, "remote");
    check("no state file: forwarded path preserved", remoteReceived.at(-1)?.path, "/health");
    check("API key forwarded as X-Whisper-Key", remoteReceived.at(-1)?.headers["x-whisper-key"], "test-key-123");
  });

  // ---- POST with a body + content-type, still routed to remote ----
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/whisper/transcribe`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=xyz" },
      body: "fake-audio-bytes",
    });
    check("POST /transcribe status ok", res.status, 200);
    const last = remoteReceived.at(-1);
    check("POST body forwarded", last?.body, "fake-audio-bytes");
    check("POST content-type forwarded", last?.headers["content-type"], "multipart/form-data; boundary=xyz");
    check("POST method forwarded", last?.method, "POST");
  });

  // ---- watchdog writes state: mode=local -> proxy switches without restart ----
  resetWhisperRuntimeStateCache();
  writeFileSync(statePath, JSON.stringify({ mode: "local", remoteUrl, localUrl }));
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/whisper/health`);
    const json = await res.json() as { from: string };
    check("state mode=local: forwarded to local stub", json.from, "local");
  });

  // ---- watchdog fails back: mode=remote -> proxy switches back ----
  resetWhisperRuntimeStateCache();
  writeFileSync(statePath, JSON.stringify({ mode: "remote", remoteUrl, localUrl }));
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/whisper/health`);
    const json = await res.json() as { from: string };
    check("state mode=remote: forwarded back to remote stub", json.from, "remote");
  });

  // ---- configured locally: state file is never consulted, even if it says "local" pointing elsewhere ----
  resetWhisperRuntimeStateCache();
  writeFileSync(statePath, JSON.stringify({ mode: "local", remoteUrl: "http://10.0.0.1:9999", localUrl: "http://10.0.0.2:9999" }));
  delete process.env.WHISPER_REMOTE_URL;
  process.env.VITE_WHISPER_SERVICE_URL = localUrl;
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/whisper/health`);
    const json = await res.json() as { from: string };
    check("configured locally: forwards to configured local URL, ignoring state file content", json.from, "local");
  });

  // ---- upstream unreachable -> 503, not a hang/crash ----
  process.env.WHISPER_REMOTE_URL = "http://127.0.0.1:1"; // nothing listens here
  delete process.env.VITE_WHISPER_SERVICE_URL;
  resetWhisperRuntimeStateCache();
  writeFileSync(statePath, JSON.stringify({ mode: "remote", remoteUrl: "http://127.0.0.1:1", localUrl }));
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/whisper/health`);
    check("unreachable upstream -> 503", res.status, 503);
    const body = await res.json() as { message: string };
    check("unreachable upstream -> message mentions the target", body.message.includes("127.0.0.1:1"), true);
  });
} finally {
  if (oldApiKey === undefined) delete process.env.WHISPER_API_KEY; else process.env.WHISPER_API_KEY = oldApiKey;
  if (oldRemote === undefined) delete process.env.WHISPER_REMOTE_URL; else process.env.WHISPER_REMOTE_URL = oldRemote;
  if (oldVite === undefined) delete process.env.VITE_WHISPER_SERVICE_URL; else process.env.VITE_WHISPER_SERVICE_URL = oldVite;
  localStub.close();
  remoteStub.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
