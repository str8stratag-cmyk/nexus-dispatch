import type { Express } from 'express';
import { createServer as createViteServer, createLogger } from "vite";
import type { Server } from 'node:http';
import viteConfig from "../vite.config";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

const viteLogger = createLogger();

// Desk mode (default): no HMR websocket. The desks run `npm run dev` as their
// production server, and the HMR socket is what stopped capture on every
// update (2026-09-24, 2026-10-02): a watchdog `git pull` hot-patched the live
// capture page (React Fast Refresh re-runs effects -> the mic was released),
// and every app restart made the Vite client poll the server and then
// location.reload() the capture tab, sometimes into a blank page while the
// fresh server was still optimizing deps. With the socket off, the open page
// keeps running (capture talks to Whisper :8178 directly) and picks up new
// client code at its next periodic reload (audio-panel.tsx), after which the
// capture supervisor resumes capture by itself. Vite still invalidates
// changed modules on disk, so any reload serves the new code.
// Developers who want live reload: set DM_HMR=1 in .env.
export function isHmrEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DM_HMR === "1" || env.DM_HMR === "true";
}

export async function setupVite(server: Server, app: Express) {
  const hmrEnabled = isHmrEnabled();
  const serverOptions = {
    middlewareMode: true,
    hmr: hmrEnabled ? { server, path: "/vite-hmr" } : (false as const),
    ws: hmrEnabled ? undefined : (false as const),
    allowedHosts: true as const,
  };
  console.log(`[vite] HMR ${hmrEnabled ? "ENABLED (DM_HMR=1)" : "disabled (desk mode; set DM_HMR=1 to enable)"}`);

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);

  app.use("/{*path}", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
