// End-to-end check that browser capture survives desk updates (2026-10-03).
// Drives real Chrome (fake mic fed from test-audio.wav) against a real
// `server/index.ts` dev server and a stub Whisper on :8178, then simulates
// what a watchdog update does: a file change under the running dev server,
// an app restart, the mic stream ending, a silently dead track, a page that
// fails to boot, and an operator Stop. No MongoDB needed.
//
// Not part of `npm` deps. To run:
//   npm i --no-save playwright-core            (or set PW_CORE=/path/to/playwright-core)
//   CHROME=/usr/bin/google-chrome node trial/e2e-capture-recovery.mjs          # desk mode (HMR off)
//   CHROME=/usr/bin/google-chrome node trial/e2e-capture-recovery.mjs --hmr    # DM_HMR=1 (Fast Refresh path)
// Port 8178 must be free (do NOT run on a desk with Whisper running).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || "playwright-core");
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HMR = process.argv.includes("--hmr");
const PORT = Number(process.env.E2E_PORT || 5077);
const ORIGIN = `http://localhost:${PORT}`;
const TOUCH_FILE = path.join(repo, "shared", "extract-address.ts");

let failures = 0;
const results = [];
function record(name, ok, detail = "") {
  if (!ok) failures++;
  results.push(`${ok ? "ok  " : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  console.log(results[results.length - 1]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stub Whisper ----------------------------------------------------------
let posts = 0;
const whisper = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.end();
  if (req.method === "POST" && req.url.startsWith("/transcribe")) {
    req.resume();
    req.on("end", () => {
      posts++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ text: "" }));
    });
    return;
  }
  res.end("{}");
});
await new Promise((r) => whisper.listen(8178, "127.0.0.1", r));

// ---- app server ------------------------------------------------------------
let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(repo, "node_modules", "tsx", "dist", "cli.mjs"), "server/index.ts"], {
    cwd: repo,
    env: { ...process.env, NODE_ENV: "development", PORT: String(PORT), DM_HMR: HMR ? "1" : "", MONGODB_URI: "" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  server.stdout.on("data", (d) => (out += d));
  server.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 120; i++) {
    if (out.includes(`serving on port ${PORT}`)) return;
    await sleep(500);
  }
  throw new Error(`server did not start:\n${out}`);
}
async function stopServer() {
  if (!server) return;
  try { process.kill(-server.pid, "SIGKILL"); } catch {}
  server = null;
  await sleep(500);
}

const original = fs.readFileSync(TOUCH_FILE, "utf8");
const browser = await chromium.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${path.join(repo, "test-audio.wav")}`,
  ],
  // Keep Chrome's default autoplay policy (Playwright disables it by default).
  ignoreDefaultArgs: ["--autoplay-policy=no-user-gesture-required"],
});

try {
  await startServer();
  const context = await browser.newContext();
  await context.grantPermissions(["microphone"], { origin: ORIGIN });
  await context.addInitScript(() => {
    const n = Number(sessionStorage.getItem("e2e.loads") || "0") + 1;
    sessionStorage.setItem("e2e.loads", String(n));
    window.__e2eLoads = n;
    window.__dmStreams = [];
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await orig(c);
      window.__dmStreams.push(s);
      return s;
    };
  });
  const page = await context.newPage();
  const capturing = async () =>
    (await page.locator('[data-testid="capture-toggle"]').textContent().catch(() => ""))?.includes("Stop Capture") ?? false;
  const loads = () => page.evaluate(() => Number(sessionStorage.getItem("e2e.loads") || "0")).catch(() => -1);
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(250);
    }
    return false;
  }
  async function postsFlowing(ms = 15_000) {
    const before = posts;
    return waitFor(async () => posts > before, ms);
  }

  // A. Fresh load: capture starts with no click.
  let t = Date.now();
  await page.goto(`${ORIGIN}/`);
  record("A. auto-capture starts on load without a click", await waitFor(capturing, 20_000), `${Date.now() - t}ms`);
  record("A. chunks reach Whisper", await postsFlowing(20_000), `posts=${posts}`);
  const ctxState = await page.evaluate(async () => {
    const c = new AudioContext(); const s = c.state; await c.close(); return s;
  });
  console.log(`   (gesture-less AudioContext state in this Chrome: ${ctxState})`);

  // B. File change under the running dev server (what `git pull` does).
  const loadsB = await loads();
  const streamsB = await page.evaluate(() => window.__dmStreams.length);
  fs.writeFileSync(TOUCH_FILE, original + `\n// e2e touch ${Date.now()}\n`);
  await sleep(3_000);
  if (HMR) {
    t = Date.now();
    const back = await waitFor(capturing, 20_000);
    const streamsAfter = await page.evaluate(() => window.__dmStreams.length);
    // A new getUserMedia stream on the same page load = Fast Refresh really
    // stopped capture and the supervisor restarted it.
    record("B. [HMR] capture back after Fast Refresh", back, `${Date.now() - t}ms after +3s; loads ${loadsB} -> ${await loads()}; streams ${streamsB} -> ${streamsAfter}`);
  } else {
    record("B. [desk] file change does not reload the page", (await loads()) === loadsB, `loads ${loadsB} -> ${await loads()}`);
    record("B. [desk] capture never stopped", await capturing());
  }
  record("B. chunks still reach Whisper", await postsFlowing());
  fs.writeFileSync(TOUCH_FILE, original);

  // C. App restart (watchdog Restart-App).
  const loadsC = await loads();
  await stopServer();
  await sleep(3_000);
  await startServer();
  await sleep(4_000);
  if (HMR) {
    record("C. [HMR] page reloaded by Vite client", await waitFor(async () => (await loads()) > loadsC, 20_000));
    record("C. [HMR] capture resumed after reload", await waitFor(capturing, 25_000));
  } else {
    record("C. [desk] restart does not reload the page", (await loads()) === loadsC, `loads ${loadsC} -> ${await loads()}`);
    record("C. [desk] capture never stopped", await capturing());
  }
  record("C. chunks still reach Whisper", await postsFlowing());
  const status = await (await fetch(`${ORIGIN}/api/capture/status`)).json();
  console.log(`   /api/capture/status after restart: ${JSON.stringify(status)}`);

  // D. Mic stream ends (device reset / Chrome releases mic).
  const streamsD = await page.evaluate(() => window.__dmStreams.length);
  await page.evaluate(() => {
    const s = window.__dmStreams[window.__dmStreams.length - 1];
    s.getAudioTracks().forEach((tr) => { tr.stop(); tr.dispatchEvent(new Event("ended")); });
  });
  t = Date.now();
  record("D. mic 'ended' -> new stream acquired", await waitFor(async () => (await page.evaluate(() => window.__dmStreams.length)) > streamsD && (await capturing()), 20_000), `${Date.now() - t}ms`);
  record("D. chunks flowing again", await postsFlowing(20_000));

  // E. Track dies silently (no 'ended' event): recorder failure / stall watchdog.
  const streamsE = await page.evaluate(() => window.__dmStreams.length);
  await page.evaluate(() => {
    const s = window.__dmStreams[window.__dmStreams.length - 1];
    s.getAudioTracks().forEach((tr) => tr.stop());
  });
  t = Date.now();
  record("E. silent track death -> pipeline restarted", await waitFor(async () => (await page.evaluate(() => window.__dmStreams.length)) > streamsE && (await capturing()), 45_000), `${Date.now() - t}ms`);
  record("E. chunks flowing again", await postsFlowing(20_000));

  // E2. Recorder wedges (no chunks, no error event): the stall watchdog must
  // notice within ~20s and rebuild the pipeline.
  let stallLogged = 0;
  page.on("console", (m) => { if (m.text().includes("[capture-supervisor] no audio chunk")) stallLogged++; });
  const streamsE2 = await page.evaluate(() => window.__dmStreams.length);
  await page.evaluate(() => {
    const orig = MediaRecorder.prototype.stop;
    MediaRecorder.prototype.stop = function () { if (window.__unwedge) return orig.call(this); };
  });
  t = Date.now();
  const stalled = await waitFor(async () => stallLogged > 0, 45_000);
  await page.evaluate(() => { window.__unwedge = true; });
  record("E2. wedged recorder caught by stall watchdog", stalled, `${Date.now() - t}ms`);
  record("E2. pipeline rebuilt with a new stream", await waitFor(async () => (await page.evaluate(() => window.__dmStreams.length)) > streamsE2 && (await capturing()), 20_000));
  record("E2. chunks flowing again", await postsFlowing(20_000));

  // F. Page that fails to boot (module load error) is reloaded by the boot guard.
  const page2 = await context.newPage();
  let aborted = 0;
  await page2.route(/\/src\/main\.tsx/, (route) => (aborted++ === 0 ? route.abort() : route.continue()));
  t = Date.now();
  await page2.goto(`${ORIGIN}/`);
  const booted = await (async () => {
    const end = Date.now() + 45_000;
    while (Date.now() < end) {
      if (await page2.locator('[data-testid="capture-toggle"]').count().catch(() => 0)) return true;
      await sleep(500);
    }
    return false;
  })();
  record("F. failed boot recovers via boot guard reload", booted && aborted >= 2, `${Date.now() - t}ms, main.tsx requests=${aborted}`);
  // Second tab must not double-capture while the first holds the lock.
  await sleep(4_000);
  const standby = await page2.locator('[data-testid="capture-standby"]').count();
  const p2capturing = (await page2.locator('[data-testid="capture-toggle"]').textContent())?.includes("Stop Capture");
  record("F. second tab stays on standby (single capturer)", standby === 1 && !p2capturing);
  await page2.close();

  // G. Operator Stop is honored across reloads; Start re-arms auto-capture.
  await page.locator('[data-testid="capture-toggle"]').click();
  await waitFor(async () => !(await capturing()), 5_000);
  await page.reload();
  await sleep(8_000);
  record("G. after Stop + reload capture stays off", !(await capturing()) && (await page.locator('[data-testid="auto-capture-off"]').count()) === 1);
  await page.locator('[data-testid="capture-toggle"]').click();
  record("G. Start re-arms capture", await waitFor(capturing, 10_000));
  await page.reload();
  record("G. ...and it auto-resumes after the next reload", await waitFor(capturing, 20_000));
} catch (err) {
  record("harness error", false, String(err && err.stack || err));
} finally {
  fs.writeFileSync(TOUCH_FILE, original);
  await browser.close().catch(() => {});
  await stopServer();
  whisper.close();
}
console.log(`\n${HMR ? "[DM_HMR=1]" : "[desk mode]"} ${failures ? `${failures} FAILURES` : "all e2e checks passed"}`);
process.exit(failures ? 1 : 0);
