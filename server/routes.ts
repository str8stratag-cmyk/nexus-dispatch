import express, { type Express, type Request, type Response } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import { insertDispatchEventSchema, insertSettingsSchema, type DispatchEvent } from "@shared/schema";
import { normalizeKeywordEntry } from "@shared/keywords";
import { isSupabaseConfigured } from "./supabase";
import { registerAudioUploadRoutes } from "./audio-upload";

let cachedBotToken: string | undefined;
let cachedChatId: string | undefined;

async function getTelegramCredentials(): Promise<{ botToken?: string; chatId?: string }> {
  if (cachedBotToken && cachedChatId) {
    return { botToken: cachedBotToken, chatId: cachedChatId };
  }
  cachedBotToken = (await storage.getSetting("telegram_bot_token"))?.value;
  cachedChatId = (await storage.getSetting("telegram_chat_id"))?.value;
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
            await storage.updateEventTelegramMessageId(
              event.id,
              String(tgData.result.message_id)
            );
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
  app.post("/api/telegram/webhook/set", async (req, res) => {
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
  app.post("/api/telegram/webhook/delete", async (_req, res) => {
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

  if (event.description) {
    msg += `<b>Details:</b> ${escapeHtml(event.description)}\n`;
  }

  if (isTaken && acceptedBy) {
    msg += `\n<i>Accepted by ${escapeHtml(acceptedBy)}</i>\n`;
  }

  msg += `\n<b>📝 Transcript (for verification):</b>\n<i>${escapeHtml(event.transcript)}</i>\n`;
  msg += `\n<i>Posted: ${new Date(event.createdAt).toLocaleString()}</i>`;

  if (event.isManual) {
    msg += `\n<b>Source:</b> Manual Dispatch`;
  }

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
