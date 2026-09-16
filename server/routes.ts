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
  if (STREET_SUFFIX_ONLY.has(a)) return true;
  return false;
}

function hasKeywordSpam(transcript: string): boolean {
  const t = normalizeText(transcript);
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

      // Pin coordinates at creation. Manual entries arrive with lat/lng null
      // and auto events may come from clients that don't geocode — resolve
      // here so every event lands with coordinates when its address resolves.
      let lat = parsed.lat;
      let lng = parsed.lng;
      if ((!lat || !lng) && parsed.address) {
        const geo = await geocodeAddress(parsed.address).catch(() => null);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
        }
      }

      const event = await storage.createEvent({ ...parsed, lat, lng });

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

  // Azure Maps is the primary geocoder for dispatch records; Geoapify and
  // Nominatim are fallbacks only. The UI intentionally does not render a map.
  // Local context appended to every geocode query so generic names like
  // "Westshore", "Hyde Park", or "University Center" resolve to Tampa instead
  // of other states/countries. Override with GEOCODE_SUFFIX in .env.
  const DEFAULT_GEOCODE_SUFFIX = "Tampa, FL";
  const FLORIDA_BOUNDS: [number, number, number, number] = [-87.6, 24.5, -80.0, 31.0];

  function getGeocodeQuery(addr: string): string {
    const suffix = process.env.GEOCODE_SUFFIX?.trim() || DEFAULT_GEOCODE_SUFFIX;
    const normalized = addr.trim();
    // Don't double-append if the address already includes Tampa/FL context. The
    // FL/Florida match must anchor to the END of the address (", FL", ", Florida",
    // optional ZIP) — a ROAD named Florida ("Florida Ave", "34th, Florida Ave")
    // contains the substring but still needs the suffix, else Azure resolves
    // out-of-state matches that the Florida bounds check then rejects.
    const lower = normalized.toLowerCase();
    if (lower.includes("tampa") || /,\s*(fl|florida)(\s+\d{5})?\s*$/.test(lower)) {
      return normalized;
    }
    return `${normalized}, ${suffix}`;
  }

  function isInServiceArea(lat: number, lng: number): boolean {
    const [west, south, east, north] = FLORIDA_BOUNDS;
    return lng >= west && lng <= east && lat >= south && lat <= north;
  }

  interface GeocodeResult {
    lat: number;
    lng: number;
    display_name: string;
    provider: string;
  }

  // Tampa corridors Whisper usually transcribes with NO street type ("NEBRASKA
  // AND ORCHID"). Azure resolves an intersection only when at least one side
  // carries a suffix — the bare query matched "Orchid Ln" miles from Nebraska
  // Ave. Canonicalize the names we know; unknown cross streets ("Orchid") are
  // left bare and still resolve once the other side is typed.
  const KNOWN_ROAD_CANONICAL: [RegExp, string][] = [
    [/\bflorida(?:\s+ave(?:nue)?)?\b(?!\s+state)/gi, "Florida Ave"],
    [/\bnebraska(?:\s+ave(?:nue)?)?\b/gi, "Nebraska Ave"],
    [/\bhillsborough(?:\s+ave(?:nue)?)?\b(?!\s+county)/gi, "Hillsborough Ave"],
    [/\bfowler(?:\s+ave(?:nue)?)?\b/gi, "Fowler Ave"],
    [/\bfletcher(?:\s+ave(?:nue)?)?\b/gi, "Fletcher Ave"],
    [/\bwaters(?:\s+ave(?:nue)?)?\b/gi, "Waters Ave"],
    [/\bhimes(?:\s+ave(?:nue)?)?\b/gi, "Himes Ave"],
    [/\bdale\s+mabry(?:\s+hwy|\s+highway)?\b/gi, "Dale Mabry Hwy"],
    [/\bcolumbus(?:\s+ave(?:nue)?)?\b/gi, "Columbus Ave"],
    [/\barmenia(?:\s+ave(?:nue)?)?\b/gi, "Armenia Ave"],
    [/\bmacdill(?:\s+ave(?:nue)?)?\b/gi, "MacDill Ave"],
    [/\bplatt(?:\s+st(?:reet)?)?\b/gi, "Platt St"],
    [/\bchannelside(?:\s+dr(?:ive)?)?\b/gi, "Channelside Dr"],
    [/\badamo(?:\s+dr(?:ive)?)?\b/gi, "Adamo Dr"],
    [/\briverview(?:\s+dr(?:ive)?)?\b/gi, "Riverview Dr"],
    [/\bbrandon(?:\s+blvd|\s+boulevard)?\b/gi, "Brandon Blvd"],
    [/\bbearss(?:\s+ave(?:nue)?)?\b/gi, "Bearss Ave"],
    [/\bgunn(?:\s+hwy|\s+highway)?\b/gi, "Gunn Hwy"],
    [/\bbruce\s+b\s+downs(?:\s+blvd|\s+boulevard)?\b/gi, "Bruce B Downs Blvd"],
    [/\behrlich(?:\s+rd|\s+road)?\b/gi, "Ehrlich Rd"],
    [/\bosbou?rne(?:\s+ave(?:nue)?)?\b/gi, "Osborne Ave"],
    [/\bcomanche(?:\s+ave(?:nue)?)?\b/gi, "Comanche Ave"],
    [/\bwilder(?:\s+ave(?:nue)?)?\b/gi, "Wilder Ave"],
    [/\blivingston(?:\s+ave(?:nue)?)?\b/gi, "Livingston Ave"],
    [/\bmemorial(?:\s+hwy|\s+highway)?\b(?!\s+parkway)/gi, "Memorial Highway"],
    [/\b(?:dr\s+)?martin\s+luther\s+king(?:\s+jr)?(?:\s+blvd|\s+boulevard)?\b/gi, "Martin Luther King Jr Blvd"],
    [/\bmlk\b/gi, "Martin Luther King Jr Blvd"],
    [/\bbusch(?:\s+blvd|\s+boulevard)?\b(?!\s+gardens)/gi, "Busch Blvd"],
    [/\bsligh(?:\s+ave(?:nue)?)?\b/gi, "Sligh Ave"],
    [/\bkennedy(?:\s+blvd|\s+boulevard)?\b/gi, "Kennedy Blvd"],
    [/\bbroadway(?:\s+ave(?:nue)?)?\b/gi, "Broadway Ave"],
    [/\bbayshore(?:\s+blvd|\s+boulevard)?\b/gi, "Bayshore Blvd"],
    [/\bwest\s+shore(?:\s+blvd|\s+boulevard)?\b/gi, "West Shore Blvd"],
    [/\bgandy(?:\s+blvd|\s+boulevard)?\b/gi, "Gandy Blvd"],
    [/\bbay\s+to\s+bay(?:\s+blvd|\s+boulevard)?\b/gi, "Bay to Bay Blvd"],
    [/\bgandhi(?:\s+blvd|\s+boulevard)?\b/gi, "Gandy Blvd"],
    [/\bgrady(?:\s+ave(?:nue)?)?\b/gi, "Grady Ave"],
    [/\bmanhattan(?:\s+ave(?:nue)?)?\b/gi, "Manhattan Ave"],
    [/\balva(?:\s+st(?:reet)?|\s+ave(?:nue)?)?\b/gi, "Alva St"],
    [/\b15th(?:\s+st(?:reet)?)?\b/gi, "15th St"],
    [/\b22nd(?:\s+st(?:reet)?)?\b/gi, "22nd St"],
    [/\b30th(?:\s+st(?:reet)?)?\b/gi, "30th St"],
    [/\b40th(?:\s+st(?:reet)?)?\b/gi, "40th St"],
    [/\b50th(?:\s+st(?:reet)?)?\b/gi, "50th St"],
    [/\b56th(?:\s+st(?:reet)?)?\b/gi, "56th St"],
  ];

  // Joiners that separate the two roads of an intersection. Directionals act
  // as linkers in clipped radio speech ("north armenia west busch").
  const INTERSECTION_SPLIT_RE = /\s+(?:and|&|@|n|s|e|w|north|south|east|west)\s+/i;

  function canonicalizeKnownRoads(address: string): string {
    let normalized = address;
    for (const [pattern, replacement] of KNOWN_ROAD_CANONICAL) {
      normalized = normalized.replace(pattern, replacement);
    }
    // Azure documents "&" for intersections; bare "and" can resolve to the
    // city centroid. Rewrite only single-linker shapes where both sides still
    // name a road ("22nd St South" must not become "22nd St & South").
    const parts = normalized.split(INTERSECTION_SPLIT_RE).map((p) => p.trim()).filter(Boolean);
    if (
      parts.length === 2 &&
      !/[&@]/.test(normalized) &&
      parts.every((p) => roadNameStem(p))
    ) {
      normalized = normalized.replace(INTERSECTION_SPLIT_RE, " & ");
    }
    return normalized;
  }

  const STEM_SUFFIX_RE = /\b(?:ave|avenue|st|street|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|cir|circle|hwy|highway|pkwy|parkway|pl|place|ter|terrace|trl|trail|way|rdg|ridge|expy|expressway|run|path|row)\b\.?/gi;
  const STEM_DIR_RE = /^(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)\s+/i;
  // Street numbers and dispatch chatter that leak into extracted addresses —
  // stripped before comparing the queried road name against the match so
  // "KENNEDY AND ALVA HONDA VS UNKNOWN" still validates against "Alva St".
  const STEM_NOISE_RE = /\b(?:\d+[a-z]?|car|cars|mvc|mva|vs|signal|signals|unknown|unkown|unknow|injury|injuries|involved|involving|invlving|rollover|airbags|deployed|block|with|minor|honda|toyota|ford|chevy|chevrolet|nissan|dodge|hyundai|mazda|jeep|bmw|audi|kia|tesla|lexus|acura|gmc|subaru|chrysler|ram)\b/gi;

  function roadNameStem(part: string): string {
    return part
      .toLowerCase()
      .replace(STEM_SUFFIX_RE, "")
      .replace(STEM_DIR_RE, "")
      .replace(STEM_NOISE_RE, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Azure Maps first, Geoapify then Nominatim as fallbacks. Returns null when
  // the address cannot be resolved inside the service area. Shared by the
  // /api/geocode endpoint and dispatch creation, so events created without
  // coordinates (manual entries arrive with lat/lng null) still get pinned.
  async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
    const azureKey = process.env.AZURE_MAPS_KEY?.trim();
    const geoapifyKey = process.env.GEOAPIFY_API_KEY?.trim();
    const boundingBox = process.env.GEOAPIFY_BOUNDING_BOX?.trim();
    const normalized = canonicalizeKnownRoads(address);
    const query = getGeocodeQuery(normalized);
    // The matched street must contain every road name in the query — a match
    // without one means the provider silently dropped it and fuzzy-matched a
    // fallback (junk addresses used to pin near E Twiggs St miles from any
    // road in the call). Rejected results fall through to the next provider.
    const queryStems = normalized
      .split(INTERSECTION_SPLIT_RE)
      .map((p) => roadNameStem(p))
      .filter((s) => s.length >= 2);
    // Route-only queries ("I-20") reduce to a meaningless stem after number
    // stripping — validate them against the route designation instead, so a
    // city fallback can't stand in for an interstate that isn't there.
    const routeOnly = normalized.match(/^\s*(i[- ]?\d{1,3}|us[- ]?\d{1,4}|sr[- ]?\d{1,4}|state road \d{1,4}|route \d{1,4})\s*$/i);
    const validateMatch = (streetName: string): boolean => {
      if (routeOnly) {
        const route = routeOnly[1].toLowerCase();
        return streetName.includes(route) || streetName.includes(route.replace(/\s+/g, "-"));
      }
      return queryStems.length === 0 || queryStems.every((s) => streetName.includes(s));
    };

    // 1. Try Azure Maps (primary)
    if (azureKey) {
      try {
        const params = new URLSearchParams({
          "api-version": "2026-01-01",
          query,
          top: "1",
        });
        if (boundingBox) {
          params.set("bbox", boundingBox);
        }
        params.set("countrySet", "US");

        const azureRes = await fetch(
          `https://atlas.microsoft.com/geocode?${params.toString()}`,
          { headers: { "subscription-key": azureKey } },
        );
        if (azureRes.ok) {
          const data = await azureRes.json();
          const result = data.features?.[0];
          const [lng, lat] = result?.geometry?.coordinates ?? [];
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const matchedStreet = `${result?.properties?.address?.streetName || ""} ${result?.properties?.address?.street || ""} ${result?.properties?.address?.addressLine || ""} ${result?.properties?.address?.formattedAddress || ""}`.toLowerCase();
            if (!validateMatch(matchedStreet)) {
              console.warn(`Azure match lacks queried road for "${address}" (query: "${query}") -> ${result?.properties?.address?.formattedAddress}`);
            } else if (!isInServiceArea(lat, lng)) {
              console.warn(`Geocoded "${address}" outside Florida: ${lat},${lng}`);
              return null;
            } else {
              return {
                lat,
                lng,
                display_name: result.properties?.address?.formattedAddress ?? address,
                provider: "azure-maps",
              };
            }
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
            const props = result?.properties ?? {};
            const matchedStreet = `${props.street || ""} ${props.road || ""} ${props.name || ""} ${props.address_line1 || ""} ${props.formatted || ""}`.toLowerCase();
            if (!validateMatch(matchedStreet)) {
              console.warn(`Geoapify match lacks queried road for "${address}" (query: "${query}") -> ${props.formatted}`);
            } else if (
              bounds &&
              (lng < bounds[0] || lng > bounds[2] || lat < bounds[1] || lat > bounds[3])
            ) {
              console.warn(`Geocoded "${address}" outside configured bounding box: ${lat},${lng}`);
              return null;
            } else if (!isInServiceArea(lat, lng)) {
              console.warn(`Geocoded "${address}" outside Florida: ${lat},${lng}`);
              return null;
            } else {
              return {
                lat,
                lng,
                display_name: props.formatted ?? address,
                provider: "geoapify",
              };
            }
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
        const matchedStreet = `${data[0].address?.road || ""} ${data[0].address?.street || ""} ${data[0].address?.name || ""} ${data[0].display_name || ""}`.toLowerCase();
        if (!validateMatch(matchedStreet)) {
          console.warn(`Nominatim match lacks queried road for "${address}" (query: "${query}") -> ${data[0].display_name}`);
        } else if (!isInServiceArea(lat, lng)) {
          console.warn(`Geocoded "${address}" outside Florida: ${lat},${lng}`);
          return null;
        } else {
          return {
            lat,
            lng,
            display_name: data[0].display_name,
            provider: "nominatim",
          };
        }
      }
    } catch (err) {
      console.error("Nominatim geocoding failed:", err);
    }

    return null;
  }

  app.get("/api/geocode", async (req, res) => {
    const address = req.query.q as string;
    if (!address) {
      return res.status(400).json({ message: "Address query parameter 'q' is required" });
    }

    try {
      const result = await geocodeAddress(address);
      if (!result) {
        return res.status(404).json({ message: "Address not found or outside service area" });
      }
      res.json(result);
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

  return msg;
}
