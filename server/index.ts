import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes, setTelegramWebhook } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      // GET bodies (the polled /api/events feed) are not logged: each one
      // stringified the full event array, grew the log to 1GB in days, and
      // the multi-MB sync stringify/writes wedged the app (2026-09-21).
      if (capturedJsonResponse && req.method !== "GET") {
        const body = JSON.stringify(capturedJsonResponse);
        logLine += ` :: ${body.length > 400 ? `${body.slice(0, 400)}…(${body.length}b)` : body}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);

  // Crash forensics: the 2026-09-21 wedge/death left nothing in the log.
  process.on("uncaughtException", (err) => {
    log(`uncaughtException: ${err.stack || err} — exiting for watchdog restart`, "process");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log(`unhandledRejection: ${reason instanceof Error ? (reason.stack || reason) : JSON.stringify(reason)}`, "process");
  });

  // 5-minute heartbeat: RSS + event-loop lag, so the next wedge/death has context.
  let lastBeat = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastBeat - 5 * 60 * 1000;
    lastBeat = now;
    log(`heartbeat rss=${Math.round(process.memoryUsage().rss / 1048576)}MB loopLag=${lag}ms`, "process");
  }, 5 * 60 * 1000).unref();

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      ...(process.platform !== "win32" && { reusePort: true }),
    },
    () => {
      log(`serving on port ${port}`);
      // If TELEGRAM_WEBHOOK_URL is configured, register it with Telegram automatically.
      // For local dev without a public tunnel, leave it unset and use the
      // /api/telegram/webhook/set endpoint once you have a public URL (e.g. ngrok).
      setTelegramWebhook().catch((err) => log(`Telegram webhook setup failed: ${err.message}`, "telegram"));
    },
  );
})();
