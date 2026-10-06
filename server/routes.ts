import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import rateLimit from "express-rate-limit";
import { ObjectId } from "mongodb";
import { storage } from "./storage";
import { insertDispatchEventSchema, insertSettingsSchema, type DispatchEvent, type InsertDispatchEvent } from "@shared/schema";
import { normalizeKeywordEntry } from "@shared/keywords";
import { extractAddress } from "@shared/extract-address";
import { suggestStreets, levenshtein, type StreetDictionary } from "@shared/street-match";
import { getDatabase, isMongoConfigured } from "./mongodb";
import { registerAudioUploadRoutes } from "./audio-upload";
import { getWhisperModel } from "./whisper";
import { decideLease, releaseLease, type CaptureLease } from "@shared/capture-lease";
import {
  parseAcceptCallbackData,
  formatTelegramAccepterName,
  isTelegramAcceptPollEnabled,
} from "./telegram-accept-helpers";

const sseClients = new Set<Response>();

const serverStartedAt = Date.now();
let captureLease: CaptureLease | null = null;
let lastCaptureHeartbeat: {
  at: number;
  source: string | null;
  capturing: boolean;
  autoCapture: boolean;
  lock: string | null;
  lastChunkAgoMs: number | null;
  lastSentAgoMs: number | null;
} | null = null;

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
  // Don't double-append if the address already includes Tampa/FL context. The
  // FL/Florida match must anchor to the END of the address (", FL", ", Florida",
  // optional ZIP) — a ROAD named Florida ("Florida Ave", "34th, Florida Ave")
  // contains the substring but still needs the suffix, else Azure resolves
  // out-of-state matches that the Florida bounds check then rejects.
  const lower = normalized.toLowerCase();
  // "tampa" must be anchored as city context (comma before it, e.g. "..., Tampa"
  // or "..., Tampa, FL") — a bare substring check also matched roads whose name
  // CONTAINS "tampa" (e.g. "Tampania Ave"), silently skipping the suffix and
  // reproducing the exact out-of-state-mismatch bug the FL/Florida anchor
  // below was written to close (found 2026-09-22).
  if (/,\s*tampa\b/.test(lower) || /,\s*(fl|florida)(\s+\d{5})?\s*$/.test(lower)) {
    return normalized;
  }
  return `${normalized}, ${suffix}`;
}

function isInServiceArea(lat: number, lng: number): boolean {
  const [west, south, east, north] = FLORIDA_BOUNDS;
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

// Tampa corridors Whisper usually transcribes with NO street type ("NEBRASKA
// AND ORCHID"). Azure resolves an intersection only when at least one side
// carries a suffix — the bare query matched "Orchid Ln" miles from Nebraska
// Ave. Canonicalize the names we know; unknown cross streets ("Orchid") are
// left bare and still resolve once the other side is typed.
const KNOWN_ROAD_CANONICAL: [RegExp, string][] = [
  // "8401 North Carolina Street" (2026-10-01, real quarantine misses on
  // four independent boxes) - real address is "3401 S Carolina St"
  // (user-confirmed 2026-10-02). Optional leading "4" catches "Signal 4"
  // fusing into "8401" with no space.
  [/\b4?8401\s+north\s+carolina(?:\s+st(?:reet)?)?\b/gi, "3401 S Carolina St"],
  [/\bflorida(?:\s+ave(?:nue)?)?\b(?!\s+state)/gi, "Florida Ave"],
  [/\bnebraska(?:\s+ave(?:nue)?)?\b/gi, "Nebraska Ave"],
  [/\bhillsborough(?:\s+ave(?:nue)?)?\b(?!\s+county)/gi, "Hillsborough Ave"],
  [/\b(?:fowler|fouler|fowlers)(?:\s+ave(?:nue)?)?\b/gi, "Fowler Ave"],
  [/\bfletcher(?:\s+ave(?:nue)?)?\b/gi, "Fletcher Ave"],
  [/\bwaters(?:\s+ave(?:nue)?)?\b/gi, "Waters Ave"],
  [/\bhimes(?:\s+ave(?:nue)?)?\b/gi, "Himes Ave"],
  [/\bhale(?:\s+ave(?:nue)?)?\b/gi, "Hale Ave"],
  [/\bdale\s+mabry(?:\s+hwy|\s+highway)?\b/gi, "Dale Mabry Hwy"],
  // "Dale Labrie" (2026-09-30, real DISP-2 quarantine miss) and "Dale may
  // be" (2026-09-30, DISP-5 quarantine) are Dale Mabry mishearings.
  // Anderson and Henderson are BOTH real Tampa roads, so "Anderson" is never
  // rewritten to "Henderson" (owner decision 2026-10-01).
  [/\bdale\s+labrie\b/gi, "Dale Mabry Hwy"],
  [/\bdale\s+may\s+be\b(?=\s*(?:[,.;:!?]|$)|\s+(?:&|(?:and|at|highway|hwy|north|south|east|west|northbound|southbound|thank)\b))/gi, "Dale Mabry Hwy"],
  [/\bhenderson(?:\s+blvd|\s+boulevard)?\b/gi, "Henderson Blvd"],
  // Whisper fuses "Dale Mabry" into one word (2026-10-01: "Cypress and
  // Delmigras" was a real Cypress & Dale Mabry call that never dispatched).
  [/\bdelmigras\b/gi, "Dale Mabry Hwy"],
  [/\bcolumbus(?:\s+ave(?:nue)?)?\b/gi, "Columbus Ave"],
  [/\barmenia(?:\s+ave(?:nue)?)?\b/gi, "Armenia Ave"],
  // Armenia Ave & Broad St, "304 East Handler" (2026-10-01, real quarantine
  // misses, user-confirmed). "Armenian" requires "avenue"/"ave" - it's a
  // real word (could describe a person) unlike "Barat"/"Tambler".
  [/\barmenian\s+(?:avenue|ave)\b/gi, "Armenia Ave"],
  // Broad St only in a street context - "broad/barat street", a
  // directional ("west broad"), or paired with Armenia - never bare "broad"
  // ("broad daylight"). Lookarounds, not capture groups, so the replacement
  // stays a literal road name for knownRoadOnlyQuery().
  [/\b(?:broad|barat)\s+st(?:reet)?\b/gi, "Broad St"],
  [/(?<=\b(?:north|south|east|west)\s+)(?:broad|barat)\b(?!\s+st(?:reet)?\b)/gi, "Broad St"],
  [/(?<=\bArmenia Ave\s+(?:and|&|at)\s+)(?:broad|barat)\b(?!\s+st(?:reet)?\b)/gi, "Broad St"],
  [/\b(?:broad|barat)\b(?!\s+st(?:reet)?\b)(?=\s+(?:and|&|at)\s+armenia\b)/gi, "Broad St"],
  [/\btambler\b/gi, "Handler"],
  [/\bmacdill(?:\s+ave(?:nue)?)?\b/gi, "MacDill Ave"],
  [/\bplatt(?:\s+st(?:reet)?)?\b/gi, "Platt St"],
  [/\bchannelside(?:\s+dr(?:ive)?)?\b/gi, "Channelside Dr"],
  [/\badamo(?:\s+dr(?:ive)?)?\b/gi, "Adamo Dr"],
  [/\briverview(?:\s+dr(?:ive)?)?\b/gi, "Riverview Dr"],
  [/\bbrandon(?:\s+blvd|\s+boulevard)?\b/gi, "Brandon Blvd"],
  [/\bbearss(?:\s+ave(?:nue)?)?\b/gi, "Bearss Ave"],
  [/\bgunn(?:\s+hwy|\s+highway)?\b/gi, "Gunn Hwy"],
  [/\bbruce\s+b\s+downs(?:\s+blvd|\s+boulevard)?\b/gi, "Bruce B Downs Blvd"],
  // Whisper mishearings of Bruce B Downs (2026-09-25 DISP-3 miss). Kept in
  // sync with ADDRESS_HOMOPHONES in shared/extract-address.ts; all anchored on
  // two-word phrases so a bare "Bruce"/"downs" is never rewritten.
  [/\bbruce\s+(?:be|bee|v|vee|d|p)\.?\s+downs?(?:\s+blvd|\s+boulevard)?\b/gi, "Bruce B Downs Blvd"],
  [/\bbruce\s+b\.\s+downs?(?:\s+blvd|\s+boulevard)?\b/gi, "Bruce B Downs Blvd"],
  [/\bbruce(?:y|ie)?\s+downs(?:\s+blvd|\s+boulevard)?\b/gi, "Bruce B Downs Blvd"],
  [/\bbruce\s+vi(?:a|e)nn?a\b/gi, "Bruce B Downs Blvd"],
  [/\bcrispy\s+downs\b/gi, "Bruce B Downs Blvd"],
  [/\behrlich(?:\s+rd|\s+road)?\b/gi, "Ehrlich Rd"],
  [/\bosborne(?:\s+ave(?:nue)?)?\b/gi, "Osborne Ave"],
  [/\bcomanche(?:\s+ave(?:nue)?)?\b/gi, "Comanche Ave"],
  [/\bol+a\b/gi, "Ola Ave"],
  [/\bwilder(?:\s+ave(?:nue)?)?\b/gi, "Wilder Ave"],
  [/\blivingston(?:\s+ave(?:nue)?)?\b/gi, "Livingston Ave"],
  [/\bmemorial(?:\s+hwy|\s+highway)?\b(?!\s+parkway)/gi, "Memorial Highway"],
  [/\bmorris\s+bridge(?:\s+rd|\s+road)?\b/gi, "Morris Bridge Rd"],
  [/\b(?:dr\s+)?martin\s+luther\s+king(?:\s+jr)?(?:\s+blvd|\s+boulevard)?\b/gi, "Martin Luther King Jr Blvd"],
  [/\bmlk\b/gi, "Martin Luther King Jr Blvd"],
  [/\be-brush\b/gi, "Busch Blvd"],
  [/\bbresh\b/gi, "Busch Blvd"],
  // Whisper small hears "Busch" as "bridge" before a block number.
  [/\bbridge\s+(\d{1,3})\b/gi, "and $1"],
  [/\bbusch(?:\s+blvd|\s+boulevard)?\b(?!\s+gardens)/gi, "Busch Blvd"],
  // "bushed" (2026-09-30 call review): \bbush\b alone doesn't match — "bush"
  // and "ed" are one contiguous word, no boundary between them.
  [/\bbush(?:ed)?\b/gi, "Busch Blvd"],
  // Whisper hears "Busch" as "e-brush" — map the mangling to the corridor.
  [/\be[- ]brush\b(?!\s+gardens)/gi, "Busch Blvd"],
  [/\bsligh(?:\s+ave(?:nue)?)?\b/gi, "Sligh Ave"],
  [/\bkennedy(?:\s+blvd|\s+boulevard)?\b/gi, "Kennedy Blvd"],
  [/\bbroadway(?:\s+ave(?:nue)?)?\b/gi, "Broadway Ave"],
  [/\b(?:lake\s+)?nona(?:\s+(?:road|rd|blvd|boulevard|pkwy|parkway))?\b/gi, "Nona"],
  // Selmon/Crosstown Expressway (2026-09-30, real DISP-5 quarantine miss:
  // "settlement expressway" for "Selmon Expressway"; also "salmon"/
  // "sandman"/"sellman"). Bare match, no "expressway"/"expy" required —
  // real dispatchers say it bare ~98% of the time (user, 2026-09-30), same
  // as "Selmon"/"Crosstown" below.
  [/\b(?:settlement|salmon|sandman|sellman)(?:\s+expressway|\s+expy)?\b/gi, "Selmon Expy"],
  [/\bselmon(?:\s+expressway|\s+expy)?\b/gi, "Selmon Expy"],
  [/\bcrosstown(?:\s+expressway|\s+expy)?\b/gi, "Selmon Expy"],
  [/\bbayshore(?:\s+blvd|\s+boulevard)?\b/gi, "Bayshore Blvd"],
  [/\bwest\s+shore(?:\s+blvd|\s+boulevard)?\b/gi, "West Shore Blvd"],
  [/\bgandy(?:\s+blvd|\s+boulevard)?\b/gi, "Gandy Blvd"],
  [/\bbay\s+to\s+bay(?:\s+blvd|\s+boulevard)?\b/gi, "Bay to Bay Blvd"],
  [/\bgandhi(?:\s+blvd|\s+boulevard)?\b/gi, "Gandy Blvd"],
  [/\bosbou?rne(?:\s+ave(?:nue)?)?\b/gi, "Osborne Ave"],
  [/\bgrady(?:\s+ave(?:nue)?)?\b/gi, "Grady Ave"],
  [/\bmanhattan(?:\s+ave(?:nue)?)?\b/gi, "Manhattan Ave"],
  [/\balva(?:\s+st(?:reet)?|\s+ave(?:nue)?)?\b/gi, "Alva St"],
  [/\b15th(?:\s+st(?:reet)?)?\b/gi, "15th St"],
  [/\b22nd(?:\s+st(?:reet)?)?\b/gi, "22nd St"],
  [/\b30th(?:\s+st(?:reet)?)?\b/gi, "30th St"],
  [/\b40th(?:\s+st(?:reet)?)?\b/gi, "40th St"],
  [/\b50th(?:\s+st(?:reet)?)?\b/gi, "50th St"],
  [/\b56th(?:\s+st(?:reet)?)?\b/gi, "56th St"],
  [/\bazeele(?:\s+st(?:reet)?)?\b/gi, "Azeele St"],
  [/\btampania(?:\s+ave(?:nue)?)?\b/gi, "Tampania Ave"],
  // Spelling bridges to what providers actually hold: Whisper writes "amberley"
  // but OSM has "Amberly" — the substring validation then rejects a real match.
  [/\bamberl?ey(?:\s+dr(?:ive)?)?\b/gi, "Amberly Dr"],
  [/\belmer(?:\s+st(?:reet)?)?\b/gi, "Elmer St"],
];

// Joiners that separate the two roads of an intersection. Directionals act
// as linkers in clipped radio speech ("north armenia west busch"). "amd" and
// "an" are Whisper's mis-hearings of "and" between street names ("AZEELE AMD
// TAMPANIA", "30TH AN FOWLER"), "at" is plain dispatcher speech — all gated
// by the both-sides-must-name-a-road check below.
const INTERSECTION_SPLIT_RE = /\s+(?:and|amd|an|at|&|@|n|s|e|w|north|south|east|west)\s+/i;

function canonicalizeKnownRoads(address: string): string {
  // Dispatch chatter the extractor can't reliably drop tails the query and
  // breaks Azure intersections ("INTERSTATE 275 AND BUSCH BLVD SECTOR",
  // "VICINITY OF 275", "30TH AT JUST ABOUT HILLSBOROUGH") — strip it first.
  let normalized = address
    .replace(/\b(?:sector|vicinity|just\s+about)\b\.?/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
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
const STEM_NOISE_RE = /\b(?:\d+[a-z]?|car|cars|mvc|mva|vs|signal|signals|unknown|unkown|unknow|injury|injuries|involved|involving|invlving|rollover|airbags|deployed|block|with|minor|honda|toyota|ford|chevy|chevrolet|nissan|dodge|hyundai|mazda|jeep|bmw|audi|kia|tesla|lexus|acura|gmc|subaru|chrysler|ram|bridge)\b/gi;

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

async function geocodeAddressWithQuery(address: string): Promise<GeocodeResult | null> {
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
  } catch (err: any) {
    console.error("Nominatim geocoding failed:", err);
  }

  return null;
}

// Corridors recognized in KNOWN_ROAD_CANONICAL that appear in the address,
// reduced to a bare "Ave & Ave" query. Trailing radio chatter ("Busch Blvd 3,
// bridge") makes providers fuzzy-match a centroid the validator then rejects;
// the bare corridor still pins approximately. Unknown roads get no fallback.
function knownRoadOnlyQuery(address: string): string | null {
  const roads = new Set<string>();
  for (const [pattern, replacement] of KNOWN_ROAD_CANONICAL) {
    if (address.match(pattern)) roads.add(replacement);
  }
  if (roads.size === 0) return null;
  return Array.from(roads).join(" & ");
}

async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const direct = await geocodeAddressWithQuery(address);
  if (direct) return direct;
  const roadOnly = knownRoadOnlyQuery(address);
  if (roadOnly && roadOnly !== address) {
    return geocodeAddressWithQuery(roadOnly);
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
        "api-version": "2026-01-01",
        coordinates: `${lng},${lat}`,
      });
      const res = await fetch(
        `https://atlas.microsoft.com/reverseGeocode?${params.toString()}`,
        { headers: { "subscription-key": azureKey } },
      );
      if (res.ok) {
        const data = await res.json();
        const result = data.features?.[0]?.properties?.address;
        const road = result?.streetName || result?.street || null;
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
  "live stream",
  "livestream",
  "youtube",
];

// Show/announcement phrases that reject a dispatch UNCONDITIONALLY — a real
// dispatch never follows "this is a production of...", so unlike the soft
// TV_VIDEO_PHRASES these are not bypassed by signal+address heuristics.
const HARD_PRODUCTION_PHRASES = [
  "this is a production of",
  "thank you for your attention",
  "thanks for watching",
  "thank you for watching",
  // Not banned: the Whisper initial_prompt itself starts with "Dispatch radio
  // terminology", and Whisper echoes that prompt into noisy audio — banning it
  // here quarantines prompt-echo false positives (seen 2026-09-17).
  "one, two, three",
];

// Radio checks / mic tests where someone runs through the signal numbers
// ("signal 3, signal 5, signal 6, ... signal 38"). A real dispatch carries
// one, maybe two signal types — 4+ distinct numbers is a counting run.
function isSignalCountingRun(transcript: string): boolean {
  const numbers = new Set<string>();
  const re = /\bsignal\s+(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(transcript)) !== null) {
    numbers.add(match[1]);
    if (numbers.size >= 4) return true;
  }
  return false;
}

const STREET_SUFFIX_ONLY = new Set([
  "street", "st", "avenue", "ave", "road", "rd", "boulevard", "blvd", "drive", "dr",
  "lane", "ln", "court", "ct", "circle", "cir", "highway", "hwy", "parkway", "pkwy",
  "place", "pl", "terrace", "ter", "trail", "trl", "way", "loop", "cove", "point",
  "run", "ridge", "rdg", "spur", "plaza", "sq", "square", "alley", "bridge", "bypass",
  "causeway", "center", "centre", "commons", "curve", "divide", "estate", "expressway", "expy",
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

// Chatter fragments that leak into parsed addresses from non-dispatch audio.
const ADDRESS_CHATTER = [
  "sorry",
  "thank you",
  "excuse me",
  "you're welcome",
  "live stream",
  "livestream",
];

function isInvalidAutoAddress(address: string | null | undefined): boolean {
  const a = (address || "").trim().toLowerCase();
  if (!a || a === "" || a.includes("unknown") || a === "n/a" || a === "null") return true;
  // Reject addresses that are just a street suffix (e.g. "wall", "drive", "point").
  if (STREET_SUFFIX_ONLY.has(a)) return true;
  // Reject addresses that are actually conversation fragments.
  if (ADDRESS_CHATTER.some((p) => a.includes(p))) return true;
  return false;
}

// True when the address names at least one road from KNOWN_ROAD_CANONICAL.
// Hardening for the auto-dispatch gate: an address that FAILED to geocode and
// names no known road is usually Whisper fabricating a street on noise
// ("4808 North Hell Avenue") — quarantine it instead of publishing a
// coord-less event. Real calls on minor streets are recoverable via
// /api/quarantine restore. Global regexes are stateful; reset per test.
function mentionsKnownRoad(address: string | null | undefined): boolean {
  const a = address || "";
  if (!a.trim()) return false;
  return KNOWN_ROAD_CANONICAL.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(a);
  });
}

// A bare road name (e.g. "Dale Mabry") has no block number and no cross
// street, so geocoding can only pin the road centroid — the marker is
// approximate and dispatch may need to search for the exact location.
function isBareRoadName(address: string | null | undefined): boolean {
  const a = (address || "").trim().toLowerCase();
  if (!a || isInvalidAutoAddress(a)) return false;
  if (/\d/.test(a)) return false;
  if (/\band\b|@|&|\//.test(a)) return false;
  return true;
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

// Road Mentions (major road named, no crash keyword) are review prompts, not
// dispatches — on their own they flood the feed (~half of all events). Tune
// (2026-09-12): require a second signal — dispatch context in the same
// transmission, or the same road already active in a recent event.
// Anything else is quarantined for review, not dropped.
const ROAD_MENTION_WINDOW_MS = 45 * 60 * 1000;
const ROAD_MENTION_CONTEXT_RE =
  /\b(units?|respond\w*|en route|copy(?: that)?|dispatch\w*|emergency|callers?|complainant|victims?|witness(?:es)?|suspects?|blocking|blocked|lanes?|10-?\d{1,2}|signal[- ]?\d{1,2}|shots? fired|smoke)\b/i;

function normalizeRoadName(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Dedup decisions only concern recent still-open events. Query just those
// (createdAt is indexed) instead of storage.getEvents(), whose full-collection
// fetch measured ~7s on Atlas M0 — with the old single-connection pool it
// stalled every concurrent request and "locked the app up".
async function recentActiveEvents(sinceMs: number): Promise<DispatchEvent[]> {
  const db = await getDatabase();
  const docs = await db
    .collection("dispatchEvents")
    .find({ createdAt: { $gte: new Date(sinceMs) }, status: { $in: ["active", "accepted"] } })
    .toArray();
  return docs as unknown as DispatchEvent[];
}

async function roadMentionedRecently(address: string | null | undefined): Promise<boolean> {
  const road = normalizeRoadName(address);
  if (road.length < 4) return false;
  const cutoff = Date.now() - ROAD_MENTION_WINDOW_MS;
  const events = await recentActiveEvents(cutoff);
  return events.some((e) => {
    if (e.status !== "active" && e.status !== "accepted") return false;
    if (new Date(e.createdAt).getTime() < cutoff) return false;
    const eAddr = normalizeRoadName(e.address);
    return eAddr === road || eAddr.includes(road) || road.includes(eAddr);
  });
}

// Street dictionary for fuzzy-matching garbled street names against real
// Tampa/Hillsborough roads (shared/street-match.ts). Generated once by
// scripts/generate-street-dictionary.ts and committed; loaded lazily. Feature
// is off when the file is missing (e.g. dictionary not generated on a box).
let streetDictionary: StreetDictionary | null | undefined;
function getStreetDictionary(): StreetDictionary | null {
  if (streetDictionary !== undefined) return streetDictionary;
  try {
    streetDictionary = JSON.parse(
      readFileSync(path.join(process.cwd(), "shared", "tampa-street-dictionary.json"), "utf8"),
    ) as StreetDictionary;
  } catch {
    streetDictionary = null;
    console.log("[street-match] tampa-street-dictionary.json not found — fuzzy street matching disabled");
  }
  return streetDictionary;
}

// Rejected auto-dispatches go to a quarantine collection instead of being
// silently dropped, so a real call killed by a false-positive gate (spam
// filter, address resolution) can be reviewed and recovered afterwards.
async function quarantineRejection(parsed: InsertDispatchEvent, reason: string): Promise<void> {
  try {
    const db = await getDatabase();
    await db.collection("quarantinedDispatches").insertOne({
      reason,
      transcript: parsed.transcript,
      address: parsed.address ?? null,
      keywords: parsed.keywords ?? null,
      source: parsed.source ?? null,
      signalType: parsed.signalType ?? null,
      whisperModel: parsed.whisperModel ?? null,
      createdAt: new Date(),
    });
  } catch {
    // Quarantine is best-effort; never block the rejection response on it.
  }
}

function rejectAutoDispatch(res: Response, parsed: InsertDispatchEvent, reason: string) {
  console.log(
    `[quarantine] ${reason} :: transcript="${(parsed.transcript || "").slice(0, 140)}" :: address=${parsed.address || "(none)"} :: source=${parsed.source || "?"}`
  );
  void quarantineRejection(parsed, reason);
  return res.status(400).json({ message: `Auto-dispatch rejected: ${reason}` });
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

  // Machine identity — the client derives its default district/source
  // (DISP-N → District N / source "DISP-N") so capture can auto-configure
  // after a restart without manual entry.
  app.get("/api/machine", (_req, res) => {
    res.json({ hostname: hostname() });
  });

  // Capture-page liveness (2026-10-03). The capture tab POSTs a heartbeat
  // every 60s; the desk watchdog reads /api/capture/status and reopens the
  // page only when NO heartbeat has arrived for a long time (tab closed,
  // crashed, or stuck on a blank screen). In-memory only, local to this box.
  app.post("/api/capture/heartbeat", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
    lastCaptureHeartbeat = {
      at: Date.now(),
      source: typeof b.source === "string" ? b.source.slice(0, 64) : null,
      capturing: b.capturing === true,
      autoCapture: b.autoCapture !== false,
      lock: typeof b.lock === "string" ? b.lock.slice(0, 16) : null,
      lastChunkAgoMs: num(b.lastChunkAgoMs),
      lastSentAgoMs: num(b.lastSentAgoMs),
    };
    res.json({ ok: true });
  });

  app.get("/api/capture/status", (_req, res) => {
    const now = Date.now();
    res.json({
      uptimeMs: now - serverStartedAt,
      lastHeartbeatAgoMs: lastCaptureHeartbeat ? now - lastCaptureHeartbeat.at : null,
      last: lastCaptureHeartbeat,
      leaseHolder: captureLease && captureLease.expiresAt > now ? captureLease.tabId : null,
    });
  });

  // One capturing tab per box, across origins (shared/capture-lease.ts).
  app.post("/api/capture/lease", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const tabId = typeof b.tabId === "string" ? b.tabId.slice(0, 64) : "";
    const decision = decideLease(
      captureLease,
      { tabId, capturing: b.capturing === true, force: b.force === true },
      Date.now(),
    );
    if (decision.lease?.tabId !== captureLease?.tabId && decision.granted) {
      console.log(`[capture] lease -> ${tabId}${b.force === true ? " (Start pressed)" : ""}`);
    }
    captureLease = decision.lease;
    res.json({ granted: decision.granted, ttlMs: decision.lease ? decision.lease.expiresAt - Date.now() : 0 });
  });

  app.post("/api/capture/lease/release", express.text({ type: "*/*" }), (req, res) => {
    let tabId = "";
    try {
      const raw = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      tabId = typeof raw?.tabId === "string" ? raw.tabId : "";
    } catch {
      // ignore malformed beacon
    }
    captureLease = releaseLease(captureLease, tabId);
    res.json({ ok: true });
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

  // Quarantined auto-dispatches — clips rejected by the auto-dispatch gates
  // (spam filter, unresolved address, TV audio...). Kept for review so a real
  // call killed by a false positive can be inspected and restored.
  app.get("/api/quarantine", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 200, 1000);
      // Express's qs parser turns ?reason[$ne]=x into an object, not a
      // string — "as string" is a compile-time-only cast that doesn't
      // change that, so an unvalidated value here let a caller inject
      // Mongo query operators through this field (found 2026-09-22).
      const reasonRaw = req.query.reason;
      const reason = typeof reasonRaw === "string" ? reasonRaw : "";
      const db = await getDatabase();
      const filter = reason ? { reason } : {};
      const items = await db
        .collection("quarantinedDispatches")
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Promote a quarantined item to a real dispatch event. It was rejected by
  // the gates once, so create it as manual to bypass the auto-dispatch
  // filters; a human pressing "restore" is the override.
  app.post("/api/quarantine/:id/restore", requireAuth, writeLimiter, async (req, res) => {
    try {
      const db = await getDatabase();
      const doc = await db
        .collection("quarantinedDispatches")
        .findOne({ _id: new ObjectId(String(req.params.id)) });
      if (!doc) {
        return res.status(404).json({ message: "Quarantined item not found" });
      }
      const address: string | null = doc.address ?? null;
      // Quarantined items were rejected BEFORE the geocoding step in
      // /api/dispatch ever ran (spam/TV/address gates), so they carry no
      // lat/lng — restoring straight from the doc left every restored event
      // with a null map pin (found 2026-09-22). Geocode here the same way.
      let lat: number | null = null;
      let lng: number | null = null;
      let geocodedRoad: string | null = null;
      if (address) {
        const geo = await geocodeAddress(address);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
        }
      }
      if (lat && lng) {
        geocodedRoad = await reverseGeocodeRoad(lat, lng);
      }
      const event = await storage.createEvent({
        transcript: String(doc.transcript ?? ""),
        keywords: String(doc.keywords ?? "[]"),
        address,
        signalType: doc.signalType ?? null,
        district: "Unknown",
        source: doc.source ?? "Unknown",
        status: "active",
        isManual: true,
        whisperModel: doc.whisperModel ?? null,
        lat,
        lng,
        geocodedRoad,
        locationApprox: isBareRoadName(address),
      });
      await db.collection("quarantinedDispatches").deleteOne({ _id: doc._id });
      broadcastEvent(event);
      res.json(event);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Create a dispatch event (auto or manual)
  app.post("/api/dispatch", dispatchLimiter, async (req, res) => {    try {
      // Some fleet tooling re-posts stored events fetched from /api/events
      // (full documents, _id included) on a loop. Short-circuit those: it's
      // the same event, and running them through geocode/dedup burned 4-8s
      // of provider calls per cycle on junk addresses.
      const echoId = (req.body as { _id?: unknown })?._id;
      if (echoId) {
        try {
          const db = await getDatabase();
          const existing = await db
            .collection("dispatchEvents")
            .findOne({ _id: new ObjectId(String(echoId)) });
          if (existing) {
            return res.status(200).json({ duplicate: true, event: existing });
          }
        } catch {
          // Not a valid ObjectId / not found — fall through to normal intake.
        }
      }

      const parsed = insertDispatchEventSchema.parse(req.body);

      // Stamp which Whisper model produced this event (fleet accuracy comparison).
      // Must run BEFORE the eventFields destructure below — the stored event
      // spreads eventFields, so a backfill afterwards never reaches it.
      if (!parsed.whisperModel) {
        const model = await getWhisperModel();
        if (model) parsed.whisperModel = model;
      }

      // Address backfill (auto-dispatch only): a capture client with a stale
      // bundle, or a clipped phrase the client missed, can POST address=null
      // while the transcript still names a location. Re-run the shared
      // extractor here. Must run BEFORE the eventFields destructure below.
      // Manual dispatches keep exactly what the operator entered.
      if (!parsed.isManual && isInvalidAutoAddress(parsed.address) && parsed.transcript) {
        const extracted = extractAddress(parsed.transcript);
        if (extracted.address && !isInvalidAutoAddress(extracted.address)) {
          parsed.address = extracted.address;
          if (extracted.crossStreet && !parsed.crossStreet) {
            parsed.crossStreet = extracted.crossStreet;
          }
          console.log(`[address-backfill] source=${parsed.source || "?"} -> ${extracted.address}`);
        }
      }

      // skipDedup is an intake-only flag (see schema) — keep it out of the
      // stored event document.
      const { skipDedup, ...eventFields } = parsed;

      // Auto-dispatches without a real address are usually TV/noise false positives.
      // Manual dispatches can still be created without an address.
      if (!parsed.isManual) {
        // Show/recap audio ("this is a production of...") can contain a real
        // address AND a crash keyword from a recap — reject it unconditionally.
        const productionPhrase = HARD_PRODUCTION_PHRASES.find((p) =>
          normalizeText(parsed.transcript).includes(p)
        );
        if (productionPhrase) {
          return rejectAutoDispatch(res, parsed, `production audio (${productionPhrase})`);
        }
        // Radio checks that count through the signal numbers.
        if (isSignalCountingRun(parsed.transcript)) {
          return rejectAutoDispatch(res, parsed, "signal counting run (radio check)");
        }
        // A strong dispatch signal + real address overrides noise phrases
        // (e.g. TV audio before the actual call).
        const likelyReal = isLikelyRealDispatch(parsed.transcript, parsed.address);
        if (containsTvVideoPhrase(parsed.transcript) && !likelyReal) {
          return rejectAutoDispatch(res, parsed, "detected TV/video audio");
        }
        // Repeated words ("yeah yeah yeah yeah") are normal in radio chatter,
        // so the spam filter is laxer than the TV filter: either a dispatch
        // signal or a real address is enough to override it.
        const hasSpamOverride =
          DISPATCH_SIGNALS.some((s) => normalizeText(parsed.transcript).includes(s)) ||
          !isInvalidAutoAddress(parsed.address);
        if (hasKeywordSpam(parsed.transcript) && !hasSpamOverride) {
          return rejectAutoDispatch(res, parsed, "keyword spam detected");
        }
        if (isInvalidAutoAddress(parsed.address)) {
          return rejectAutoDispatch(res, parsed, "requires a resolved address");
        }
        // Road Mentions need a second signal (see roadMentionedRecently).
        if (parsed.signalType === "Road Mention") {
          const hasContext = ROAD_MENTION_CONTEXT_RE.test(parsed.transcript);
          if (!hasContext && !(await roadMentionedRecently(parsed.address))) {
            return rejectAutoDispatch(res, parsed, "road mention lacks corroborating signal");
          }
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

      // Street-dictionary correction: when geocoding failed, match the garbled
      // street against real Tampa roads and re-geocode the corrected query.
      // geocodeAddress only returns once the provider's match contains the
      // queried road, so a non-null result IS the verification — a wrong
      // guess can't produce a pin. Score floor 0.85: live corrections publish
      // immediately.
      if (!lat && !lng && parsed.address) {
        const [suggestion] = suggestStreets(parsed.address, getStreetDictionary());
        if (suggestion && suggestion.score >= 0.85) {
          const correctedGeo = await geocodeAddress(suggestion.correctedAddress);
          if (correctedGeo) {
            console.log(
              `[streetfix] "${parsed.address}" -> "${suggestion.correctedAddress}" (score ${suggestion.score})`,
            );
            parsed.address = suggestion.correctedAddress;
            lat = correctedGeo.lat;
            lng = correctedGeo.lng;
          }
        }
      }

      // Cross-reference the resolved coordinates against the actual road name.
      if (lat && lng) {
        geocodedRoad = await reverseGeocodeRoad(lat, lng);
      }

      // Hardening: geocoding failed AND the address names no known road —
      // almost always Whisper inventing a street on noise. Quarantine for
      // review rather than publish a coord-less event.
      if (!parsed.isManual && parsed.address && !lat && !lng && !mentionsKnownRoad(parsed.address)) {
        return rejectAutoDispatch(res, parsed, "unrecognized street (geocode failed)");
      }

      // Suppress near-duplicate dispatches. The same incident gets
      // re-broadcast on the radio for hours; without this, each broadcast
      // creates a fresh event and Telegram alert for the same call.
      // Applies to feed events and reconciler (DISP-3) output. The manual
      // entry form sets skipDedup so dispatchers can always log a call.
      if (!skipDedup) {
        const DEDUP_WINDOW_MS = 30 * 60 * 1000;
        const DEDUP_RADIUS_M = 500;
        const norm = (s: string | null | undefined) =>
          (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        // Road Mention review prompts: one per road per 15 minutes. These name
        // a major road without a crash keyword, so busy corridors re-alert
        // constantly (Florida Ave fired 28x in 24h); a repeat mention of the
        // same road within minutes adds nothing new. Keyworded dispatches are
        // unaffected — only keyword-less mentions dedupe here. Road mentions
        // stay exempt from the incident dedup below — this cooldown is their
        // only suppression.
        if (parsed.signalType === "Road Mention") {
          const ROAD_MENTION_COOLDOWN_MS = 15 * 60 * 1000;
          const roadKey = norm(parsed.address || "") || norm(parsed.crossStreet || "");
          const roadCutoff = Date.now() - ROAD_MENTION_COOLDOWN_MS;
          if (roadKey) {
            const recentSameRoad = (await recentActiveEvents(roadCutoff)).find((e) => {
              if (e.signalType !== "Road Mention") return false;
              if (e.status !== "active" && e.status !== "accepted") return false;
              if (new Date(e.createdAt).getTime() < roadCutoff) return false;
              return norm(e.address || "") === roadKey || norm(e.crossStreet || "") === roadKey;
            });
            if (recentSameRoad) {
              return res.status(200).json({ duplicate: true, event: recentSameRoad });
            }
          }
        }
        const crashClass = new Set(["mva", "mvc", "signal 4", "signal4", "10 50"]);
        const sameIncidentType = (a: string, b: string) => {
          const na = norm(a);
          const nb = norm(b);
          return na === nb || (crashClass.has(na) && crashClass.has(nb));
        };
        const distanceM = (aLat: number, aLng: number, bLat: number, bLng: number) => {
          const toRad = (d: number) => (d * Math.PI) / 180;
          const dLat = toRad(bLat - aLat);
          const dLng = toRad(bLng - aLng);
          const h =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
          return 2 * 6371000 * Math.asin(Math.sqrt(h));
        };
        // Mishearings of the same road geocode differently ("regions park" vs
        // "regents park" land far apart or fail to geocode), so exact address
        // equality misses re-broadcasts of the same call. Fuzzy fallback:
        // substring, token overlap, or near-levenshtein. Numbered streets must
        // match exactly — "50th st" vs "56th st" is a different incident.
        // levenshtein imported from @shared/street-match.
        const addressesSimilar = (a: string, b: string): boolean => {
          if (a.includes(b) || b.includes(a)) return true;
          const numsA = a.split(" ").filter((t) => /^\d/.test(t));
          const numsB = b.split(" ").filter((t) => /^\d/.test(t));
          if (numsA.length > 0 && numsB.length > 0 && numsA.join(" ") !== numsB.join(" ")) {
            return false;
          }
          const ta = a.split(" ");
          const tb = b.split(" ");
          const overlap = ta.filter((t) => tb.includes(t)).length;
          if (overlap / Math.max(ta.length, tb.length) >= 0.6) return true;
          return levenshtein(a, b) / Math.max(a.length, b.length) <= 0.25;
        };
        // Cross-machine insert race: two DISP-N boxes can both pass the fuzzy
        // check below for the same radio call within milliseconds of each
        // other (separate processes on separate machines, no shared lock) and
        // both insert + both alert Telegram. Close the window with a
        // short-lived claim keyed on incident type + coarse location — Mongo's
        // _id uniqueness is the only synchronization primitive every box
        // actually shares. Road Mention events never match the fuzzy check
        // below (see the signalType guard there), so they're intentionally
        // not covered here — their own race is handled by the cooldown above.
        if (lat && lng) {
          const typeKey = crashClass.has(norm(parsed.signalType)) ? "crash" : norm(parsed.signalType);
          const CLAIM_CELL_DEG = 0.0045; // ~500m, matches DEDUP_RADIUS_M
          const latCell = Math.round(lat / CLAIM_CELL_DEG);
          const lngCell = Math.round(lng / CLAIM_CELL_DEG);
          const claimKey = `${typeKey}|${latCell}|${lngCell}`;
          try {
            const db = await getDatabase();
            await db.collection<{ _id: string; createdAt: Date }>("dispatchClaims").insertOne({ _id: claimKey, createdAt: new Date() });
          } catch (err) {
            if ((err as { code?: number }).code === 11000) {
              // Another box just claimed this bucket — give its insert a
              // moment to land, then let the normal fuzzy check below find it.
              await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
            } else {
              console.error("Dispatch claim insert failed:", err);
            }
          }
        }
        const cutoff = Date.now() - DEDUP_WINDOW_MS;
        const newAddr = norm(parsed.address);
        const newTranscript = norm(parsed.transcript);
        const existing = (await recentActiveEvents(cutoff)).find((e) => {
          if (e.status !== "active" && e.status !== "accepted") return false;
          if (new Date(e.createdAt).getTime() < cutoff) return false;
          // Identical transcript in the window = the same broadcast reposted
          // (e.g. a feed replaying audio, or the reconciler re-emitting a
          // call that was already entered), even if the parsed address or
          // signal type came out differently.
          if (newTranscript.length >= 20 && newTranscript === norm(e.transcript)) return true;
          // Bare-road "Road Mention" events all geocode to the same road
          // centroid, so coordinate/address dedupe would suppress every
          // distinct mention of the same road within the window (e.g. four
          // separate MLK transmissions 15 min apart = one event). Only
          // identical-transcript replays dedupe for this class.
          if (parsed.signalType === "Road Mention" || e.signalType === "Road Mention") return false;
          if (!sameIncidentType(e.signalType || "", parsed.signalType || "")) return false;
          if (lat && lng && e.lat != null && e.lng != null) {
            if (distanceM(lat, lng, e.lat, e.lng) < DEDUP_RADIUS_M) return true;
          }
          const eAddr = norm(e.address);
          return newAddr.length >= 5 && eAddr.length >= 5 && addressesSimilar(newAddr, eAddr);
        });
        if (existing) {
          return res.status(200).json({ duplicate: true, event: existing });
        }
      }

      let event = await storage.createEvent({ ...eventFields, lat, lng, geocodedRoad, locationApprox: isBareRoadName(parsed.address) });
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
  app.patch("/api/events/:id/status", requireAuth, writeLimiter, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
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

  // Housekeeping: Road Mention review prompts go stale fast — dispatchers
  // either listen back immediately or never. Auto-resolve them after 90 min
  // so the board doesn't accumulate dead prompts.
  const roadMentionSweeper = setInterval(async () => {
    try {
      const staleBefore = new Date(Date.now() - 90 * 60 * 1000);
      const db = await getDatabase();
      // Query only the stale prompts. storage.getEvents() full-scan measured
      // ~7s on Atlas M0 (per-doc wire cost ~7ms x every doc in the
      // collection) and stalled other requests back when the pool was 1.
      const stale = await db
        .collection("dispatchEvents")
        .find({ signalType: "Road Mention", status: "active", createdAt: { $lt: staleBefore } })
        .toArray();
      for (const e of stale) {
        const updated = await storage.updateEventStatus((e as unknown as DispatchEvent).id, "resolved");
        if (updated) broadcastEvent(updated);
      }
    } catch (err) {
      console.error("road mention sweeper failed:", err);
    }
  }, 5 * 60 * 1000);
  roadMentionSweeper.unref();

  // Geocode an address via geocodeAddress: Azure Maps (primary), then
  // Geoapify, then OpenStreetMap Nominatim as final fallback.
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

  if (event.locationApprox) {
    msg += `<b>⚠️ APPROXIMATE LOCATION:</b> single cross street named — may need to search exact location. READ DISPATCH FOR CONTEXT.\n`;
  }

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

export {
  parseAcceptCallbackData,
  formatTelegramAccepterName,
  isTelegramAcceptPollEnabled,
} from "./telegram-accept-helpers";

export async function handleTelegramUpdate(update: any): Promise<void> {
  if (!update.callback_query) return;

  const callback = update.callback_query;
  const data = callback.data as string;
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;

  if (!data || !chatId || !messageId) return;

  const eventId = parseAcceptCallbackData(data);
  if (eventId == null) return;

  const { botToken, chatId: configuredChatId } = await getTelegramCredentials();
  if (!botToken || !configuredChatId || String(chatId) !== configuredChatId) {
    return;
  }

  const existing = await storage.getEvent(eventId);
  if (!existing) {
    await telegramApiCall(botToken, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "This dispatch no longer exists.",
      show_alert: true,
    });
    return;
  }

  if (existing.status === "accepted") {
    await telegramApiCall(botToken, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "This call has already been accepted.",
      show_alert: true,
    });
    return;
  }

  if (existing.status !== "active") {
    await telegramApiCall(botToken, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "This dispatch is no longer available to accept.",
      show_alert: true,
    });
    return;
  }

  const accepter = formatTelegramAccepterName(callback.from);

  // Atomic claim — if another tap (or desk) already accepted, treat as already taken.
  const updated = await storage.claimEventAccepted(eventId, accepter);
  if (!updated) {
    await telegramApiCall(botToken, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "This call has already been accepted.",
      show_alert: true,
    });
    return;
  }
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


// ---------------------------------------------------------------------------
// Accept-button long-poll (Disp-1 only via TELEGRAM_ACCEPT_POLL=1)
// ---------------------------------------------------------------------------
// Desks have no public HTTPS URL, so Telegram cannot push callback_query to
// /api/telegram/webhook. Exactly one designated desk (preferred: Disp-1) sets
// TELEGRAM_ACCEPT_POLL=1 and long-polls getUpdates. All other desks leave the
// flag unset/off so they never compete for the bot's update stream.
//
// If two desks somehow poll the same bot: Telegram returns 409 Conflict to the
// loser (we back off). The shared Mongo offset (telegram_poll_offset) and the
// atomic claimEventAccepted() guard prevent double-accept on the board.
//
// Webhook path (TELEGRAM_WEBHOOK_URL) is for a future public host
// (AWS / app.StrataG.app). Webhook and polling are mutually exclusive for a
// bot — if both env vars are set, webhook wins and polling stays off.

const TELEGRAM_POLL_OFFSET_KEY = "telegram_poll_offset";
let telegramPollingStarted = false;

export function startTelegramPolling(): void {
  if (telegramPollingStarted) return;
  telegramPollingStarted = true;
  void telegramPollLoop();
}

async function telegramPollLoop(): Promise<void> {
  let backoffMs = 5_000;
  for (;;) {
    // Everything below (credential lookup, offset read/write) can throw on a
    // storage/Mongo blip. This loop is started fire-and-forget via
    // `void telegramPollLoop()`, so an uncaught throw here would kill Accept
    // polling permanently until process restart. Catch at the outer level
    // and back off instead of exiting.
    try {
      const { botToken } = await getTelegramCredentials();
      if (!botToken) {
        console.warn("[telegram] Accept poll: bot token missing — retry in 60s");
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }

      let data: { ok: boolean; result?: any[]; description?: string };
      try {
        const storedRaw = (await storage.getSetting(TELEGRAM_POLL_OFFSET_KEY))?.value ?? "0";
        const stored = parseInt(storedRaw, 10);
        const offset = Number.isFinite(stored) && stored > 0 ? stored : undefined;
        // Long-poll ~25s. Node fetch waits; allowed_updates keeps the queue to Accept taps.
        data = await telegramApiCall(botToken, "getUpdates", {
          offset,
          timeout: 25,
          allowed_updates: ["callback_query"],
        });
      } catch (err: any) {
        console.error(
          `[telegram] getUpdates failed: ${err?.message ?? err} — retry in ${backoffMs / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 120_000);
        continue;
      }

      if (!data.ok) {
        // 409 = another consumer holds the bot (webhook still set, or another desk polling).
        console.error(
          `[telegram] getUpdates: ${data.description} — backing off ${backoffMs / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 120_000);
        continue;
      }

      backoffMs = 5_000;
      for (const update of data.result ?? []) {
        try {
          await handleTelegramUpdate(update);
        } catch (err) {
          console.error("[telegram] callback handling failed:", err);
        }
        try {
          // Advance offset even on handler failure so a poison update cannot wedge the loop.
          await storage.upsertSetting({
            key: TELEGRAM_POLL_OFFSET_KEY,
            value: String(update.update_id + 1),
          });
        } catch (err) {
          console.error("[telegram] failed to persist poll offset:", err);
        }
      }
    } catch (err: any) {
      console.error(
        `[telegram] accept poll loop error: ${err?.message ?? err} — retry in ${backoffMs / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 120_000);
    }
  }
}

/**
 * Start Telegram Accept transport for this process.
 * - TELEGRAM_WEBHOOK_URL set → register webhook (future public host).
 * - else TELEGRAM_ACCEPT_POLL=1 → delete any leftover webhook once, then long-poll.
 * - else → no Accept receiver on this desk (send still works; taps go nowhere).
 */
export async function initTelegramAcceptTransport(): Promise<void> {
  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim();
  const poll = isTelegramAcceptPollEnabled();

  if (webhookUrl) {
    if (poll) {
      console.warn(
        "[telegram] TELEGRAM_WEBHOOK_URL and TELEGRAM_ACCEPT_POLL are both set — using webhook; polling stays off",
      );
    }
    await setTelegramWebhook(webhookUrl);
    return;
  }

  if (!poll) {
    console.log(
      "[telegram] Accept receiver idle (set TELEGRAM_ACCEPT_POLL=1 on exactly one desk, preferred Disp-1, or TELEGRAM_WEBHOOK_URL for a public host)",
    );
    return;
  }

  const { botToken } = await getTelegramCredentials();
  if (!botToken) {
    console.warn("[telegram] TELEGRAM_ACCEPT_POLL set but bot token not configured — not polling");
    return;
  }

  // Clear a leftover webhook once at setup of the polling desk so getUpdates works.
  // Do NOT call this on every desk or as the default "no webhook URL" path.
  const cleared = await deleteTelegramWebhook();
  console.log(
    `[telegram] TELEGRAM_ACCEPT_POLL enabled — long-polling Accept callbacks (webhook cleared: ${cleared.success})`,
  );
  startTelegramPolling();
}

