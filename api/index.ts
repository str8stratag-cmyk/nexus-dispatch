import express, { Request, Response, NextFunction } from "express";
import { createServer } from "node:http";
import { registerRoutes, setTelegramWebhook } from "../server/routes";

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

let ready: Promise<void> | null = null;
function init() {
  if (!ready) {
    ready = registerRoutes(httpServer, app).then(() => {
      app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
        const status = err.status || err.statusCode || 500;
        const message = err.message || "Internal Server Error";
        console.error("Internal Server Error:", err);
        if (res.headersSent) return;
        res.status(status).json({ message });
      });
      // Set Telegram webhook on cold start if TELEGRAM_WEBHOOK_URL is configured.
      setTelegramWebhook().catch((err) => console.error("Telegram webhook setup failed:", err));
    });
  }
  return ready;
}

export default async function handler(req: Request, res: Response) {
  await init();
  app(req, res);
}
