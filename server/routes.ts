import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { insertDispatchEventSchema, insertSettingsSchema, type DispatchEvent } from "@shared/schema";
import { normalizeKeywordEntry } from "@shared/keywords";
import { isMongoConfigured } from "./mongodb";
import { registerAudioUploadRoutes } from "./audio-upload";

const sseClients = new Set<Response>();

function broadcastEvent(event: DispatchEvent): void {
  const data = JSON.stringify(event);
  const clients = Array.from(sseClients);
  for (const client of clients) {
    client.write(`event: dispatch\ndata: ${data}\n\n`);
  }
}

let cachedBotToken: string | undefined;
let cachedChatId: string | undefined;

const dispatchLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many dispatch requests, please try again later." },
});

const settingsLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many settings requests, please try again later." },
});

const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});

const ADMIN_SECRET = process.env.ADMIN_SECRET;

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_SECRET) return next();
  const token = req.headers["x-admin-secret"] || req.query.secret;
  if (token === ADMIN_SECRET) return next();
  res.status(401).json({ message: "Unauthorized. Set x-admin-secret header." });
}

async function getTelegramCredentials(): Promise<{ botToken?: string; chatId?: string }> {
  if (cachedBotToken && cachedChatId) {
    return { botToken: cachedBotToken, chatId: cachedChatId };
  }
  cachedBotToken = (await storage.getSetting("telegram_bot_token"))?.value || process.env.TELEGRAM_BOT_TOKEN;
  cachedChatId = (await storage.getSetting("telegram_chat_id"))?.value || process.env.TELEGRAM_CHAT_ID;
  return { botToken: cachedBotToken, chatId: cachedChatId };
}

export async function clearTelegramCredentialsCache(): Promise<void> {
  cachedBotToken = undefined;
  cachedChatId = undefined;
}

async function telegramApiCall(
  botToken: string,
  method: string,
  payload: Record<string, any>
): Promise<{ ok: boolean; result?: any; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text().catch(() => "{}");
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: false, description: text };
  }
  return data;
}

interface GeocodeResult {
  lat: number;
  lng: number;
  display_name: string;
  provider: string;
}

// Local context appended to every geocode query so generic names like
// "Westshore", "Hyde Park", or "University Center" resolve to Tampa instead
// of other states/countries. Override with GEOCODE_SUFFIX in .env.
const DEFAULT_GEOCODE_SUFFIX = "Tampa, FL";

// Rough Florida bounding box. Coordinates outside this box are treated as
// bad geocodes and rejected. west,south,east,north
const FLORIDA_BOUNDS: [number, number, number, number] = [-87.6, 24.5, -80.0, 31.0];

function getGeocodeQuery(address: string): string {
  const suffix = process.env.GEOCODE_SUFFIX?.trim() || DEFAULT_GEOCODE_SUFFIX;
  const normalized = address.trim();
  // Don't double-append if the address already includes Tampa/FL context.
  const lower = normalized.toLowerCase();
  if (lower.includes("tampa") || lower.includes("florida") || lower.includes(", fl")) {
    return normalized;
  }
  return `${normalized}, ${suffix}`;
}

function isInServiceArea(lat: number, lng: number): boolean {
  const [west, south, east, north] = FLORIDA_BOUNDS;
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const azureKey = process.env.AZURE_MAPS_KEY?.trim();
  const geoapifyKey = process.env.GEOAPIFY_API_KEY?.trim();
  const boundingBox = process.env.GEOAPIFY_BOUNDING_BOX?.trim();
  const query = getGeocodeQuery(address);

  // 1. Try Azure Maps (primary)
  if (azureKey) {
    try {
      const params = new URLSearchParams({
        "api-version": "2023-06-01",
        query,
        limit: "1",
        "subscription-key": azureKey,
      });
      if (boundingBox) {
        params.set("bbox", boundingBox);
      }
      params.set("countrySet", "US");

      const azureRes = await fetch(
        `https://atlas.microsoft.com/geocode/search/json?${params.toString()}`,
      );
      if (azureRes.ok) {
        const data = await azureRes.json();
        const result = data.results?.[0];
        const lat = result?.position?.lat;
        const lng = result?.position?.lon;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          if (!isInServiceArea(lat, lng)) {
            console.warn(`Geocoded "${address}" outside Florida: ${lat},${lng}`);
            return null;
          }
          return {
            lat,
            lng,
            display_name: result.address?.formattedAddress ?? address,
            provider: "azure-maps",
          };
        }
      } else {
        console.error("Azure Maps geocoding failed:", azureRes.status, await azureRes.text());
      }
    } catch (err) {
      console.error("Azure Maps geocoding failed:", err);
    }
  }

  // 2. Fallback to Geoapify
  if (geoapifyKey) {
    const bounds = boundingBox?.split(",").map(Number);
    if (
      bounds &&
      (bounds.length !== 4 ||
        bounds.some((coordinate) => !Number.isFinite(coordinate)) ||
        bounds[0] >= bounds[2] ||
        bounds[1] >= bounds[3])
    ) {
      throw new Error("GEOAPIFY_BOUNDING_BOX must use west,south,east,north coordinates");
    }

    try {
      const params = new URLSearchParams({
        text: query,
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
            console.warn(`Geocoded "${address}" outside configured bounding box: ${lat},${lng}`);
            return null;
          }
          if (!isInServiceArea(lat, lng)) {
            console.warn(`Geocoded "${address}" outside Florida: ${lat},${lng}`);
            return null;
          }
          return {
            lat,
            lng,
            display_name: result.properties?.formatted ?? address,
            provider: "geoapify",
          };
        }
      } else {
        console.error("Geoapify geocoding failed:", geoapifyRes.status, await geoapifyRes.text());
      }
    } catch (err) {
      console.error("Geoapify geocoding failed:", err);
    }
  }

  // 3. Fallback to Nominatim
  try {
    const nomRes = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
      {
        headers: {
          "User-Agent": "DispatchMonitor/1.0",
        },
      }
    );
    const data = await nomRes.json();
    if (Array.isArray(data) && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      if (!isInServiceArea(lat, lng)) {
        console.warn(`Geocoded "${address}" outside Florida: ${lat},${lng}`);
        return null;
      }
      return {
        lat,
        lng,
        display_name: data[0].display_name,
        provider: "nominatim",
      };
    }
  } catch (err: any) {
    console.error("Nominatim geocoding failed:", err);
  }

  return null;
}

async function reverseGeocodeRoad(lat: number, lng: number): Promise<string | null> {
  const azureKey = process.env.AZURE_MAPS_KEY?.trim();
  const geoapifyKey = process.env.GEOAPIFY_API_KEY?.trim();

  // 1. Try Azure Maps reverse geocoding
  if (azureKey) {
    try {
      const params = new URLSearchParams({
        "api-version": "2023-06-01",
        query: `${lat},${lng}`,
        "subscription-key": azureKey,
      });
      const res = await fetch(
        `https://atlas.microsoft.com/geocode/reverse/json?${params.toString()}`,
      );
      if (res.ok) {
        const data = await res.json();
        const result = data.results?.[0];
        const road = result?.address?.streetName || result?.address?.street || null;
        if (road) return road;
      } else {
        console.error("Azure Maps reverse geocoding failed:", res.status, await res.text());
      }
    } catch (err) {
      console.error("Azure Maps reverse geocoding failed:", err);
    }
  }

  // 2. Fallback to Geoapify
  if (geoapifyKey) {
    try {
      const res = await fetch(
        `https://api.geoapify.com/v1/geocode/reverse?lat=${lat}&lon=${lng}&apiKey=${geoapifyKey}`
      );
      if (res.ok) {
        const data = await res.json();
        const props = data.features?.[0]?.properties;
        const road = props?.street || props?.road || props?.name;
        if (road) return road;
      } else {
        console.error("Geoapify reverse geocoding failed:", res.status, await res.text());
      }
    } catch (err) {
      console.error("Geoapify reverse geocoding failed:", err);
    }
  }

  // 3. Fallback to Nominatim
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
      { headers: { "User-Agent": "DispatchMonitor/1.0" } }
    );
    if (res.ok) {
      const data = await res.json();
      return data.address?.road || data.address?.street || data.address?.name || null;
    }
  } catch (err) {
    console.error("Nominatim reverse geocoding failed:", err);
  }

  return null;
}

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
  "please return to your seat",
  "what's your name",
  "what would you say",
  "i'll be there for you",
  "why come they need me",
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
  // Reject addresses that are just a street suffix (e.g. "wall", "drive", "point").
  if (STREET_SUFFIX_ONLY.has(a)) return true;
  return false;
}

function hasKeywordSpam(transcript: string): boolean {
  const t = normalizeText(transcript);
  // Detect the same word repeated 4+ times in a row (e.g. "mva mva mva mva").
  return /\b(\w+)\s+\1\s+\1\s+\1\b/.test(t);
}

const DISPATCH_SIGNALS = [
  "signal 4", "signal four",
  "signal 3", "signal three",
  "signal 16",
  "mva",
  "wreck",
  "tow",
  "airbags deployed",
  "rollover",
  "accident",
];

function isLikelyRealDispatch(transcript: string, address: string | null | undefined): boolean {
  const t = normalizeText(transcript);
  const hasSignal = DISPATCH_SIGNALS.some((s) => t.includes(s));
  const hasRealAddress = !isInvalidAutoAddress(address);
  return hasSignal && hasRealAddress;
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
      hasMongoUri: Boolean(process.env.MONGODB_URI),
      hasMongoDbName: Boolean(process.env.MONGODB_DB_NAME),
      nodeEnv: process.env.NODE_ENV || null,
    });
  });

  // Get all dispatch events
  app.get("/api/events", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 500, 1000);
      const events = await storage.getEvents(limit);
      res.json(events);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // SSE stream for real-time event updates
  app.get("/api/events/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(`event: connected\ndata: {}\n\n`);
    sseClients.add(res);

    req.on("close", () => {
      sseClients.delete(res);
    });
  });

  // Create a dispatch event (auto or manual)
  app.post("/api/dispatch", dispatchLimiter, async (req, res) => {
    try {
      const parsed = insertDispatchEventSchema.parse(req.body);

      // Auto-dispatches without a real address are usually TV/noise false positives.
      // Manual dispatches can still be created without an address.
      if (!parsed.isManual) {
        // A strong dispatch signal + real address overrides noise phrases
        // (e.g. TV audio before the actual call).
        const likelyReal = isLikelyRealDispatch(parsed.transcript, parsed.address);
        if (containsTvVideoPhrase(parsed.transcript) && !likelyReal) {
          return res.status(400).json({ message: "Auto-dispatch rejected: detected TV/video audio" });
        }
        if (hasKeywordSpam(parsed.transcript) && !likelyReal) {
          return res.status(400).json({ message: "Auto-dispatch rejected: keyword spam detected" });
        }
        if (isInvalidAutoAddress(parsed.address)) {
          return res.status(400).json({ message: "Auto-dispatch requires a resolved address" });
        }
      }

      // Geocode the address if coordinates were not provided.
      let lat = parsed.lat;
      let lng = parsed.lng;
      let geocodedRoad: string | null = null;
      if ((!lat || !lng) && parsed.address) {
        const geo = await geocodeAddress(parsed.address);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
        }
      }

      // Cross-reference the resolved coordinates against the actual road name.
      if (lat && lng) {
        geocodedRoad = await reverseGeocodeRoad(lat, lng);
      }

      let event = await storage.createEvent({ ...parsed, lat, lng, geocodedRoad });
      broadcastEvent(event);

      // Send to Telegram if configured
      const { botToken, chatId } = await getTelegramCredentials();

      if (botToken && chatId) {
        try {
          const message = formatTelegramMessage(event, { status: "active" });
          const tgData = await telegramApiCall(botToken, "sendMessage", {
            chat_id: chatId,
            text: message,
            parse_mode: "HTML",
            reply_markup: buildAcceptKeyboard(event.id),
            disable_web_page_preview: true,
          });

          if (!tgData.ok) {
            console.error("Telegram error:", tgData.description);
          } else if (tgData.result?.message_id) {
            const updated = await storage.updateEventTelegramMessageId(
              event.id,
              String(tgData.result.message_id)
            );
            if (updated) {
              event = updated;
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
      broadcastEvent(event);
      res.json(event);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Geocode an address. Use Geoapify when configured, otherwise fall back to
  // OpenStreetMap Nominatim.
  app.get("/api/geocode", async (req, res) => {
    const address = req.query.q as string;
    if (!address) {
      return res.status(400).json({ message: "Address query parameter 'q' is required" });
    }

    try {
      const result = await geocodeAddress(address);
      if (result) {
        res.json(result);
      } else {
        res.status(404).json({ message: "Address not found or outside service area" });
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
  app.post("/api/settings", requireAuth, settingsLimiter, async (req, res) => {
    try {
      const parsed = insertSettingsSchema.parse(req.body);
      const setting = await storage.upsertSetting(parsed);
      // If Telegram credentials changed, invalidate the cache so the next dispatch picks them up.
      if (setting.key === "telegram_bot_token" || setting.key === "telegram_chat_id") {
        await clearTelegramCredentialsCache();
      }
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
  app.post("/api/keywords", requireAuth, writeLimiter, async (req, res) => {
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
  app.delete("/api/keywords", requireAuth, writeLimiter, async (req, res) => {
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
  app.post("/api/telegram/test", requireAuth, writeLimiter, async (_req, res) => {
    try {
      const { botToken, chatId } = await getTelegramCredentials();

      if (!botToken || !chatId) {
        return res.status(400).json({ message: "Telegram bot token or chat ID not configured" });
      }

      const tgData = await telegramApiCall(botToken, "sendMessage", {
        chat_id: chatId,
        text: "✅ Dispatch Monitor test message — Telegram connection is working.",
        parse_mode: "HTML",
      });

      if (tgData.ok) {
        res.json({ success: true, message: "Test message sent successfully" });
      } else {
        res.status(400).json({ message: "Telegram error: " + (tgData.description || "Unknown error") });
      }
    } catch (err: any) {
      res.status(500).json({ message: "Telegram test failed: " + err.message });
    }
  });

  // Webhook endpoint for Telegram callbacks (accept button presses).
  app.post("/api/telegram/webhook", express.json(), async (req: Request, res: Response) => {
    await handleTelegramUpdate(req.body);
    res.sendStatus(200);
  });

  // Register the webhook with Telegram. Body: { url?: string }
  // If no body URL is provided, falls back to TELEGRAM_WEBHOOK_URL env var.
  app.post("/api/telegram/webhook/set", requireAuth, settingsLimiter, async (req, res) => {
    try {
      const url = req.body?.url || process.env.TELEGRAM_WEBHOOK_URL;
      if (!url) {
        return res.status(400).json({ message: "No webhook URL provided. Set TELEGRAM_WEBHOOK_URL or pass url in body." });
      }
      const result = await setTelegramWebhook(url);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Remove the webhook from Telegram (useful for local dev or switching transports).
  app.post("/api/telegram/webhook/delete", requireAuth, settingsLimiter, async (_req, res) => {
    try {
      const result = await deleteTelegramWebhook();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Audio upload: optimize with ffmpeg and store in Supabase
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

function buildGpsLink(lat: number, lng: number): string {
  // Universal link: opens in Apple Maps on iOS, Google Maps on Android/Windows if installed, browser otherwise.
  return `https://maps.apple.com/?q=${lat},${lng}`;
}

function buildAcceptKeyboard(eventId: number): { inline_keyboard: any[] } {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ Accept Call",
          callback_data: `accept_${eventId}`,
        },
      ],
    ],
  };
}

interface FormatOptions {
  status?: "active" | "accepted";
  acceptedBy?: string;
}

function formatTelegramMessage(event: DispatchEvent, options: FormatOptions = {}): string {
  const { status = "active", acceptedBy } = options;
  const isTaken = status === "accepted";

  const address = event.crossStreet
    ? `${event.address} & ${event.crossStreet}`
    : event.address || "Address unknown";

  const header = isTaken
    ? `<b>❌ TAKEN — DISPATCH #${event.id}</b>`
    : `<b>🚨 DISPATCH #${event.id} — AVAILABLE</b>`;

  let msg = `${header}\n\n`;
  msg += `<b>📍 Location:</b> ${escapeHtml(address)}\n`;

  if (event.lat && event.lng) {
    msg += `<b>🗺️ GPS:</b> <a href="${buildGpsLink(event.lat, event.lng)}">Open in Maps</a>\n`;
    msg += `<code>${event.lat.toFixed(6)}, ${event.lng.toFixed(6)}</code>\n`;
  }

  msg += `\n<b>Signal:</b> ${escapeHtml(event.signalType)}\n`;
  msg += `<b>District:</b> ${escapeHtml(event.district)}\n`;
  msg += `<b>Source:</b> ${escapeHtml(event.source)}\n`;

  if (event.geocodedRoad) {
    msg += `<b>Road X-Ref:</b> ${escapeHtml(event.geocodedRoad)}\n`;
  }

  if (event.description) {
    msg += `<b>Details:</b> ${escapeHtml(event.description)}\n`;
  }

  if (isTaken && acceptedBy) {
    msg += `\n<i>Accepted by ${escapeHtml(acceptedBy)}</i>\n`;
  }

  msg += `\n<b>📝 Transcript (for verification):</b>\n<i>${escapeHtml(event.transcript)}</i>\n`;
  msg += `\n<i>Posted: ${new Date(event.createdAt).toLocaleString()}</i>`;

  return msg;
}

async function handleTelegramUpdate(update: any): Promise<void> {
  if (!update.callback_query) return;

  const callback = update.callback_query;
  const data = callback.data as string;
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;

  if (!data || !chatId || !messageId) return;
  if (!data.startsWith("accept_")) return;

  const eventId = parseInt(data.replace("accept_", ""), 10);
  if (Number.isNaN(eventId)) return;

  const { botToken, chatId: configuredChatId } = await getTelegramCredentials();
  if (!botToken || !configuredChatId || String(chatId) !== configuredChatId) {
    return;
  }

  const event = await storage.getEvent(eventId);
  if (!event) {
    await telegramApiCall(botToken, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "This dispatch no longer exists.",
      show_alert: true,
    });
    return;
  }

  if (event.status === "accepted") {
    await telegramApiCall(botToken, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "This call has already been accepted.",
      show_alert: true,
    });
    return;
  }

  const accepter = callback.from
    ? callback.from.username
      ? `@${callback.from.username}`
      : callback.from.first_name || `User ${callback.from.id}`
    : "A driver";

  const updated = await storage.updateEventStatus(eventId, "accepted");
  if (!updated) return;
  broadcastEvent(updated);

  // Edit the original dispatch message to show it's taken and remove the accept button.
  await telegramApiCall(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: formatTelegramMessage(updated, { status: "accepted", acceptedBy: accepter }),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] },
    disable_web_page_preview: true,
  });

  await telegramApiCall(botToken, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "Call accepted. Good luck out there.",
  });
}

export async function setTelegramWebhook(url?: string): Promise<{ success: boolean; description?: string }> {
  const { botToken } = await getTelegramCredentials();
  if (!botToken) {
    throw new Error("Telegram bot token not configured");
  }

  const webhookUrl = url || process.env.TELEGRAM_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("[telegram] No webhook URL configured; skipping setWebhook.");
    return { success: false, description: "No webhook URL configured" };
  }

  console.log(`[telegram] Setting webhook to ${webhookUrl}`);
  const data = await telegramApiCall(botToken, "setWebhook", {
    url: webhookUrl,
    allowed_updates: ["callback_query"],
  });

  if (data.ok) {
    console.log("[telegram] Webhook set successfully");
  } else {
    console.error("[telegram] setWebhook failed:", data.description);
  }
  return { success: data.ok, description: data.description };
}

export async function deleteTelegramWebhook(): Promise<{ success: boolean; description?: string }> {
  const { botToken } = await getTelegramCredentials();
  if (!botToken) {
    throw new Error("Telegram bot token not configured");
  }

  console.log("[telegram] Deleting webhook");
  const data = await telegramApiCall(botToken, "deleteWebhook", {});
  if (data.ok) {
    console.log("[telegram] Webhook deleted");
  } else {
    console.error("[telegram] deleteWebhook failed:", data.description);
  }
  return { success: data.ok, description: data.description };
}
