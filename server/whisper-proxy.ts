/**
 * /api/whisper/* — same-origin proxy the client always calls instead of
 * hitting Whisper directly. The browser's own Whisper URL
 * (VITE_WHISPER_SERVICE_URL) is baked in at Vite build time and can't react
 * to a runtime failover, so the client now goes through here and this
 * server process (which re-reads config/state on every request) picks
 * local vs. remote Whisper via resolveWhisperTarget().
 */
import type { Express, Request, Response } from "express";
import { resolveWhisperTarget } from "./whisper-failover";

const MAX_BODY_BYTES = 50 * 1024 * 1024; // matches audio-upload.ts's multer limit
const FORWARD_REQUEST_HEADERS = ["content-type"];

function readRawBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export interface WhisperProxyOptions {
  /** Test-only override for the runtime state file path. */
  statePath?: string;
}

export function registerWhisperProxyRoutes(app: Express, options: WhisperProxyOptions = {}): void {
  app.use("/api/whisper", async (req: Request, res: Response) => {
    const target = resolveWhisperTarget(process.env, options.statePath).replace(/\/+$/, "");
    const subpath = req.url === "/" ? "" : req.url;
    const url = `${target}${subpath}`;

    const headers: Record<string, string> = {};
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const apiKey = process.env.WHISPER_API_KEY;
    if (apiKey) headers["X-Whisper-Key"] = apiKey;

    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    try {
      const body = hasBody ? await readRawBody(req, MAX_BODY_BYTES) : undefined;
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(65_000),
      });
      res.status(upstream.status);
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("content-type", contentType);
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.status(503).json({
        message: `Whisper is unavailable at ${target}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
