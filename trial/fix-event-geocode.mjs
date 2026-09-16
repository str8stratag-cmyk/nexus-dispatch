#!/usr/bin/env node
/**
 * One-off: re-geocode a stored event with the fixed intersection handling
 * and update its lat/lng/geocodedRoad in Mongo.
 *
 * Usage: node trial/fix-event-geocode.mjs <eventId> [eventId...]
 * Local-only tool — not part of the app.
 */

import { MongoClient } from "mongodb";
import "dotenv/config";

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || "dispatch_monitor";
const API_URL = process.env.RECONCILER_API_URL || "http://127.0.0.1:5000";

if (!MONGODB_URI) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);
if (ids.length === 0) {
  console.error("Usage: node trial/fix-event-geocode.mjs <eventId> [eventId...]");
  process.exit(1);
}

async function geocode(address) {
  const res = await fetch(`${API_URL}/api/geocode?q=${encodeURIComponent(address)}`);
  if (!res.ok) return null;
  return res.json();
}

async function reverseRoad(lat, lng) {
  const key = process.env.AZURE_MAPS_KEY?.trim();
  if (!key) return null;
  const params = new URLSearchParams({
    "api-version": "2026-01-01",
    coordinates: `${lng},${lat}`,
  });
  const res = await fetch(`https://atlas.microsoft.com/reverseGeocode?${params}`, {
    headers: { "subscription-key": key },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const addr = data.features?.[0]?.properties?.address;
  return addr?.streetName || addr?.street || null;
}

// Geoapify/Azure city-centroid fallback junk pin shared by bad geocodes.
const JUNK_PIN = { lat: 27.9495104, lng: -82.4577068 };

function distanceM(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Push the updated event over SSE so open dashboards refresh without reload.
async function broadcast(id, status) {
  await fetch(`${API_URL}/api/events/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  }).catch(() => {});
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
const collection = client.db(DB_NAME).collection("dispatchEvents");

for (const id of ids) {
  const event = await collection.findOne({ id });
  if (!event) {
    console.log(`#${id}: not found`);
    continue;
  }
  if (!event.address) {
    console.log(`#${id}: no address stored, skipped`);
    continue;
  }

  const geo = await geocode(event.address);
  if (!geo) {
    // Unresolvable: if the event sits on the junk fallback pin, clear the
    // false precision rather than leave a wrong pin (a bad pin is worse
    // than none — dispatchers search by call content anyway).
    const atJunkPin =
      event.lat != null &&
      event.lng != null &&
      distanceM(event.lat, event.lng, JUNK_PIN.lat, JUNK_PIN.lng) < 50;
    if (atJunkPin) {
      await collection.updateOne({ id }, { $set: { lat: null, lng: null, geocodedRoad: null } });
      await broadcast(id, event.status);
      console.log(`#${id}: "${event.address}" unresolvable — junk pin cleared`);
    } else {
      console.log(`#${id}: "${event.address}" does not resolve — left unchanged`);
    }
    continue;
  }

  const moved =
    event.lat == null || event.lng == null
      ? Infinity
      : distanceM(event.lat, event.lng, geo.lat, geo.lng);

  if (moved < 100) {
    console.log(`#${id}: "${event.address}" already correct (${geo.display_name})`);
    continue;
  }

  const road = await reverseRoad(geo.lat, geo.lng);
  await collection.updateOne(
    { id },
    { $set: { lat: geo.lat, lng: geo.lng, geocodedRoad: road } },
  );
  await broadcast(id, event.status);
  console.log(
    `#${id}: "${event.address}" ${event.lat},${event.lng}${event.geocodedRoad ? ` (${event.geocodedRoad})` : ""}` +
      ` -> ${geo.lat},${geo.lng} = ${geo.display_name} [x-ref: ${road}] (${Math.round(moved)}m moved)`,
  );
}

await client.close();
