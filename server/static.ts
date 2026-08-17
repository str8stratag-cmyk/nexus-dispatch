import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");

  // On published pplx.app sites, static assets are served directly from S3 —
  // this backend process only needs to handle /api routes. The dist/public
  // directory may not exist in this process's own sandbox filesystem. A
  // synchronous throw here would crash the process before it ever binds to
  // the port, which surfaces as a permanent 503 with no diagnosable error.
  // Log and skip static serving instead of crashing.
  if (!fs.existsSync(distPath)) {
    console.warn(
      `[static] Build directory not found at ${distPath} — skipping static file serving (expected when static assets are served from S3, e.g. on published pplx.app sites).`,
    );
    return;
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
