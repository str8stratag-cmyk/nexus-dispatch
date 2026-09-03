#!/usr/bin/env node
import { MongoClient } from "mongodb";
import "dotenv/config";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "dispatch_monitor";

if (!uri) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

function normalizeSource(src) {
  const s = (src || "").toString().toLowerCase().replace(/[-_]/g, " ").trim();
  if (s.includes("disp") && s.includes("1")) return "DISP1";
  if (s.includes("disp") && s.includes("2")) return "DISP2";
  if (s.includes("disp") && s.includes("3")) return "DISP3";
  if (s.includes("disp") && s.includes("4")) return "DISP4";
  if (s.includes("manual")) return "Manual";
  if (s.includes("auto")) return "Auto";
  return src || "Unknown";
}

function sourceColor(src) {
  const colors = {
    DISP1: "#3b82f6",
    DISP2: "#10b981",
    DISP3: "#f59e0b",
    DISP4: "#8b5cf6",
    Manual: "#ef4444",
    Auto: "#64748b",
  };
  return colors[src] || "#64748b";
}

function escapeSvg(text) {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

async function main() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const eventsCol = db.collection("dispatchEvents");

    // 7:39 AM today in Eastern Standard Time (EST = UTC-5)
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 39, 0));

    const events = await eventsCol
      .find({ createdAt: { $gte: startOfDay } })
      .sort({ createdAt: 1 })
      .project({
        id: 1, createdAt: 1, transcript: 1, signalType: 1,
        address: 1, crossStreet: 1, source: 1, lat: 1, lng: 1,
        geocodedRoad: 1, district: 1, status: 1,
      })
      .toArray();

    const rowHeight = 90;
    const width = 1200;
    const headerHeight = 80;
    const height = headerHeight + events.length * rowHeight + 40;

    let rows = "";
    events.forEach((e, i) => {
      const src = normalizeSource(e.source);
      const color = sourceColor(src);
      const y = headerHeight + i * rowHeight;
      const time = new Date(e.createdAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
      const addr = [e.address, e.crossStreet].filter(Boolean).join(" & ") || "No address";
      const transcript = truncate(e.transcript, 130);
      const coords = e.lat && e.lng ? `${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}` : "No GPS";

      rows += `
  <g transform="translate(20, ${y})">
    <rect x="0" y="0" width="${width - 40}" height="${rowHeight - 10}" rx="8" fill="#1e293b" stroke="#334155" stroke-width="1"/>
    <rect x="0" y="0" width="8" height="${rowHeight - 10}" rx="4" fill="${color}"/>
    <text x="20" y="28" fill="${color}" font-family="Segoe UI, sans-serif" font-size="16" font-weight="bold">#${e.id} [${src}]</text>
    <text x="200" y="28" fill="#e2e8f0" font-family="Segoe UI, sans-serif" font-size="16" font-weight="bold">${escapeSvg(e.signalType || "n/a")}</text>
    <text x="360" y="28" fill="#94a3b8" font-family="Segoe UI, sans-serif" font-size="14">${escapeSvg(time)}</text>
    <text x="500" y="28" fill="#fbbf24" font-family="Segoe UI, sans-serif" font-size="14">${escapeSvg(addr)}</text>
    <text x="940" y="28" fill="#64748b" font-family="Segoe UI, sans-serif" font-size="12">${escapeSvg(coords)}</text>
    <text x="20" y="58" fill="#cbd5e1" font-family="Segoe UI, sans-serif" font-size="13">${escapeSvg(transcript)}</text>
  </g>`;
    });

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#0f172a"/>
  <text x="30" y="45" fill="#f8fafc" font-family="Segoe UI, sans-serif" font-size="24" font-weight="bold">Dispatch Calls Since 7:39 AM EST</text>
  <text x="${width - 30}" y="45" fill="#94a3b8" font-family="Segoe UI, sans-serif" font-size="14" text-anchor="end">${events.length} events</text>
  ${rows}
</svg>`;

    const outFile = join(__dirname, "..", "shared", `calls-since-730am-${now.toISOString().slice(0, 10)}.svg`);
    writeFileSync(outFile, svg, "utf-8");
    console.log(`Exported ${events.length} calls to ${outFile}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
