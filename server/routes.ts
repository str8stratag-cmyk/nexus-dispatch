import type { Express } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import { insertDispatchEventSchema, insertSettingsSchema } from "@shared/schema";
import { normalizeKeywordEntry } from "@shared/keywords";
import { isSupabaseConfigured } from "./supabase";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Diagnostic route — confirms the process is alive and reports whether
  // Supabase credentials made it into this environment, without leaking them.
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      supabaseConfigured: isSupabaseConfigured,
      hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
      hasSupabaseAnonKey: Boolean(process.env.SUPABASE_ANON_KEY),
      nodeEnv: process.env.NODE_ENV || null,
    });
  });

  // Get all dispatch events
  app.get("/api/events", async (_req, res) => {
    try {
      const events = await storage.getEvents();
      res.json(events);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Create a dispatch event (auto or manual)
  app.post("/api/dispatch", async (req, res) => {
    try {
      const parsed = insertDispatchEventSchema.parse(req.body);
      const event = await storage.createEvent(parsed);

      // Send to Telegram if configured
      const botToken = (await storage.getSetting("telegram_bot_token"))?.value;
      const chatId = (await storage.getSetting("telegram_chat_id"))?.value;

      if (botToken && chatId) {
        try {
          const message = formatTelegramMessage(event);
          const tgRes = await fetch(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: "HTML",
              }),
            }
          );
          const tgData = await tgRes.json();
          if (!tgData.ok) {
            console.error("Telegram error:", tgData.description);
          }
        } catch (err) {
          console.error("Telegram send failed:", err);
        }
      }

      res.status(201).json(event);
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // Update event status
  app.patch("/api/events/:id/status", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { status } = req.body;
      const event = await storage.updateEventStatus(id, status);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      res.json(event);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Geocode an address via OpenStreetMap Nominatim
  app.get("/api/geocode", async (req, res) => {
    const address = req.query.q as string;
    if (!address) {
      return res.status(400).json({ message: "Address query parameter 'q' is required" });
    }
    try {
      const nomRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`,
        {
          headers: {
            "User-Agent": "DispatchMonitor/1.0",
          },
        }
      );
      const data = await nomRes.json();
      if (Array.isArray(data) && data.length > 0) {
        res.json({
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
          display_name: data[0].display_name,
        });
      } else {
        res.status(404).json({ message: "Address not found" });
      }
    } catch (err: any) {
      res.status(500).json({ message: "Geocoding failed: " + err.message });
    }
  });

  // Get all settings
  app.get("/api/settings", async (_req, res) => {
    try {
      // keyword_list is a large JSON blob managed via /api/keywords — keep it
      // out of the generic settings list so it doesn't dump raw JSON in the UI.
      const allSettings = (await storage.getAllSettings()).filter((s) => s.key !== "keyword_list");
      // Mask sensitive values
      const masked = allSettings.map((s) => {
        if (s.key === "telegram_bot_token" && s.value) {
          const val = s.value;
          const masked = val.length > 8 ? val.slice(0, 4) + "..." + val.slice(-4) : "***";
          return { ...s, value: masked };
        }
        return s;
      });
      res.json(masked);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Upsert a setting
  app.post("/api/settings", async (req, res) => {
    try {
      const parsed = insertSettingsSchema.parse(req.body);
      const setting = await storage.upsertSetting(parsed);
      res.json(setting);
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // List effective keywords/homophones (built-in defaults + custom additions)
  app.get("/api/keywords", async (_req, res) => {
    try {
      const keywords = await storage.getKeywords();
      res.json(keywords);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Add a keyword or homophone. Body: { pattern, label?, signalType? }
  // `label` and `signalType` default to `pattern` when omitted, which is the
  // common case for adding a homophone of an existing signal type (pass the
  // same signalType as the term it should be treated the same as).
  app.post("/api/keywords", async (req, res) => {
    try {
      const entry = normalizeKeywordEntry(req.body || {});
      if (!entry) {
        res.status(400).json({ message: "A non-empty 'pattern' is required" });
        return;
      }
      const updated = await storage.addKeyword(entry);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // Remove a keyword or homophone by its exact pattern (case-insensitive,
  // matched against the normalized lowercase pattern it was stored with).
  app.delete("/api/keywords", async (req, res) => {
    try {
      const pattern = String(req.body?.pattern || req.query.pattern || "").trim().toLowerCase();
      if (!pattern) {
        res.status(400).json({ message: "A 'pattern' is required" });
        return;
      }
      const updated = await storage.removeKeyword(pattern);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // Test Telegram connection
  app.post("/api/telegram/test", async (_req, res) => {
    try {
      const botToken = (await storage.getSetting("telegram_bot_token"))?.value;
      const chatId = (await storage.getSetting("telegram_chat_id"))?.value;

      if (!botToken || !chatId) {
        return res.status(400).json({ message: "Telegram bot token or chat ID not configured" });
      }

      const tgRes = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "✅ Dispatch Monitor test message — Telegram connection is working.",
            parse_mode: "HTML",
          }),
        }
      );
      const tgData = await tgRes.json();
      if (tgData.ok) {
        res.json({ success: true, message: "Test message sent successfully" });
      } else {
        res.status(400).json({ message: "Telegram error: " + (tgData.description || "Unknown error") });
      }
    } catch (err: any) {
      res.status(500).json({ message: "Telegram test failed: " + err.message });
    }
  });

  return httpServer;
}

function formatTelegramMessage(event: any): string {
  const keywords = JSON.parse(event.keywords || "[]");
  const keywordStr = keywords.length > 0 ? keywords.join(", ") : "N/A";

  let msg = `<b>🚨 DISPATCH EVENT</b>\n\n`;
  msg += `<b>Signal Type:</b> ${event.signalType || "N/A"}\n`;
  msg += `<b>District:</b> ${event.district || "N/A"}\n`;
  msg += `<b>Source:</b> ${event.source || "N/A"}\n`;
  msg += `<b>Address:</b> ${event.address || "N/A"}\n`;
  msg += `<b>Description:</b> ${event.description || "N/A"}\n`;
  msg += `<b>Keywords:</b> ${keywordStr}\n`;

  if (event.lat && event.lng) {
    msg += `<b>Location:</b> ${event.lat}, ${event.lng}\n`;
    msg += `<a href="https://www.openstreetmap.org/?mlat=${event.lat}&mlon=${event.lng}&zoom=17">View on Map</a>\n`;
  }

  msg += `\n<b>Transcript:</b>\n<i>${event.transcript || "N/A"}</i>\n`;
  msg += `\n<b>Time:</b> ${new Date(event.createdAt).toLocaleString()}`;

  if (event.isManual) {
    msg += `\n<b>Source:</b> Manual Dispatch`;
  }

  return msg;
}
