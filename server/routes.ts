import type { Express } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import { insertDispatchEventSchema, insertSettingsSchema } from "@shared/schema";
import { normalizeKeywordEntry } from "@shared/keywords";
import { isMongoConfigured } from "./mongodb";
import { registerAudioUploadRoutes } from "./audio-upload";

// Phrases that almost always mean the audio captured a TV/video instead of dispatch.
const TV_VIDEO_PHRASES = [
  "thank you for watching",
  "thanks for watching",
  "that's the end of the video",
  "that is the end of the video",
  "end of the video",
  "like and subscribe",
  "hello hello hello",
  "we interrupt coursework",
  "today's video",
  "this is just a test",
  "thank you and goodbye",
  "subscribe to our channel",
  "visit www.",
  "for more information",
  "check mark",
  "what were you waiting",
  "your daughter",
  "no answer",
];

const STREET_SUFFIX_ONLY = new Set([
  "street", "st", "avenue", "ave", "road", "rd", "boulevard", "blvd", "drive", "dr",
  "lane", "ln", "court", "ct", "circle", "cir", "highway", "hwy", "parkway", "pkwy",
  "place", "pl", "terrace", "ter", "trail", "trl", "way", "loop", "cove", "point",
  "run", "ridge", "rdg", "spur", "plaza", "sq", "square", "alley", "bridge", "bypass",
  "causeway", "center", "centre", "commons", "curve", "divide", "estate", "expressway",
  "freeway", "garden", "gardens", "gate", "green", "grove", "heights", "hill", "hills",
  "hollow", "island", "isle", "junction", "knoll", "lake", "landings", "mall", "manor",
  "meadow", "meadows", "mill", "mills", "mission", "mont", "mount", "mountain", "neck",
  "oval", "overlook", "park", "pass", "path", "pike", "pine", "pines", "prairie", "ranch",
  "river", "route", "row", "shoal", "shore", "spring", "springs", "station", "stravenue",
  "stream", "summit", "throughway", "trace", "track", "trafficway", "trailer", "tunnel",
  "turnpike", "union", "valley", "vista", "village", "vllg", "ville", "walk", "wall",
  "waters", "wells", "track", "court", "point", "drive", "way",
]);

function normalizeText(value: string): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function containsTvVideoPhrase(transcript: string): boolean {
  const t = normalizeText(transcript);
  return TV_VIDEO_PHRASES.some((p) => t.includes(p));
}

function isInvalidAutoAddress(address: string | null | undefined): boolean {
  const a = (address || "").trim().toLowerCase();
  if (!a || a === "" || a.includes("unknown") || a === "n/a" || a === "null") return true;
  if (STREET_SUFFIX_ONLY.has(a)) return true;
  return false;
}

function hasKeywordSpam(transcript: string): boolean {
  const t = normalizeText(transcript);
  return /\b(\w+)\s+\1\s+\1\s+\1\b/.test(t);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Diagnostic route — confirms the process is alive and reports whether
  // MongoDB credentials made it into this environment, without leaking them.
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      mongoConfigured: isMongoConfigured,
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

      // Auto-dispatches without a real address are usually TV/noise false positives.
      // Manual dispatches can still be created without an address.
      if (!parsed.isManual) {
        if (containsTvVideoPhrase(parsed.transcript)) {
          return res.status(400).json({ message: "Auto-dispatch rejected: detected TV/video audio" });
        }
        if (hasKeywordSpam(parsed.transcript)) {
          return res.status(400).json({ message: "Auto-dispatch rejected: keyword spam detected" });
        }
        if (isInvalidAutoAddress(parsed.address)) {
          return res.status(400).json({ message: "Auto-dispatch requires a resolved address" });
        }
      }

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
          if (!tgRes.ok) {
            console.error("Telegram HTTP error:", tgRes.status, await tgRes.text().catch(() => ""));
          } else {
            const tgData = await tgRes.json();
            if (!tgData.ok) {
              console.error("Telegram error:", tgData.description);
            }
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

  // Retain the existing geocoder for dispatch records while a replacement
  // provider is evaluated. The UI intentionally does not render a map.
  app.get("/api/geocode", async (req, res) => {
    const address = req.query.q as string;
    if (!address) {
      return res.status(400).json({ message: "Address query parameter 'q' is required" });
    }

    const geoapifyKey = process.env.GEOAPIFY_API_KEY?.trim();
    const boundingBox = process.env.GEOAPIFY_BOUNDING_BOX?.trim();

    if (geoapifyKey) {
      const bounds = boundingBox?.split(",").map(Number);
      if (
        bounds &&
        (bounds.length !== 4 ||
          bounds.some((coordinate) => !Number.isFinite(coordinate)) ||
          bounds[0] >= bounds[2] ||
          bounds[1] >= bounds[3])
      ) {
        return res.status(500).json({
          message: "GEOAPIFY_BOUNDING_BOX must use west,south,east,north coordinates",
        });
      }

      try {
        const params = new URLSearchParams({
          text: address,
          limit: "1",
          apiKey: geoapifyKey,
        });
        if (boundingBox) {
          params.set("filter", `rect:${boundingBox}`);
        }

        const geoapifyRes = await fetch(
          `https://api.geoapify.com/v1/geocode/search?${params.toString()}`,
        );
        if (geoapifyRes.ok) {
          const data = await geoapifyRes.json();
          const result = data.features?.[0];
          const [lng, lat] = result?.geometry?.coordinates ?? [];
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            if (
              bounds &&
              (lng < bounds[0] || lng > bounds[2] || lat < bounds[1] || lat > bounds[3])
            ) {
              return res.status(404).json({
                message: "Address resolved outside the configured service area",
              });
            }
            return res.json({
              lat,
              lng,
              display_name: result.properties?.formatted ?? address,
              provider: "geoapify",
            });
          }
          return res.status(404).json({ message: "Address not found in the configured service area" });
        } else {
          console.error("Geoapify geocoding failed:", geoapifyRes.status, await geoapifyRes.text());
          return res.status(502).json({ message: "Geoapify geocoding service is unavailable" });
        }
      } catch (err) {
        console.error("Geoapify geocoding failed:", err);
        return res.status(502).json({ message: "Geoapify geocoding service is unavailable" });
      }
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
          provider: "nominatim",
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

  // Audio is transcribed locally and discarded after each request.
  registerAudioUploadRoutes(app);

  return httpServer;
}

// Escape HTML so user-controlled DB values can't inject tags into Telegram HTML messages.
function escapeHtml(value: string | null | undefined): string {
  if (!value) return "N/A";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTelegramMessage(event: any): string {
  let keywords: { keyword?: string; signalType?: string }[] = [];
  try {
    keywords = JSON.parse(event.keywords || "[]");
  } catch {
    keywords = [];
  }
  const keywordStr = keywords.length > 0
    ? keywords.map((k) => k.signalType || k.keyword || "Unknown").join(", ")
    : "N/A";

  const address = event.crossStreet
    ? `${event.address} & ${event.crossStreet}`
    : event.address;

  let msg = `<b>🚨 DISPATCH EVENT</b>\n\n`;
  msg += `<b>Signal Type:</b> ${escapeHtml(event.signalType)}\n`;
  msg += `<b>District:</b> ${escapeHtml(event.district)}\n`;
  msg += `<b>Source:</b> ${escapeHtml(event.source)}\n`;
  msg += `<b>Address:</b> ${escapeHtml(address)}\n`;
  msg += `<b>Description:</b> ${escapeHtml(event.description)}\n`;
  msg += `<b>Keywords:</b> ${escapeHtml(keywordStr)}\n`;

  msg += `\n<b>Transcript:</b>\n<i>${escapeHtml(event.transcript)}</i>\n`;
  msg += `\n<b>Time:</b> ${new Date(event.createdAt).toLocaleString()}`;

  if (event.isManual) {
    msg += `\n<b>Source:</b> Manual Dispatch`;
  }

  return msg;
}
