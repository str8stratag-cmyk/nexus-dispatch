#!/usr/bin/env node
/**
 * LLM-based Dispatch Call Reconciler (Template)
 *
 * This is a stub showing where an LLM would sit. It clusters events the same
 * way as reconciler.mjs, but instead of rule-based scoring it sends the
 * transcripts to an LLM and asks for a corrected dispatch summary.
 *
 * To make this runnable:
 *  1. Set LLM_API_KEY and LLM_API_URL in your .env.
 *  2. Implement callLlm() for your provider (OpenAI, Grok, Ollama, etc.).
 *  3. Tune the prompt for your radio vocabulary.
 */

import { MongoClient } from "mongodb";
import "dotenv/config";

const API_URL = process.env.RECONCILER_API_URL || "http://127.0.0.1:5000";
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || "dispatch_monitor";
const LLM_API_URL = process.env.LLM_API_URL; // e.g. https://api.openai.com/v1/chat/completions
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const SOURCE_OUTPUT = "DISP 3";
const LOOKBACK_MS = parseInt(process.env.RECONCILER_LOOKBACK_MS || "900000", 10);
const TIME_WINDOW_MS = parseInt(process.env.RECONCILER_TIME_WINDOW_MS || "600000", 10);

if (!MONGODB_URI) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Placeholder: replace with your LLM provider
// ---------------------------------------------------------------------------
async function callLlm(prompt) {
  if (!LLM_API_URL || !LLM_API_KEY) {
    throw new Error("LLM_API_URL and LLM_API_KEY must be set to use the LLM reconciler.");
  }

  const res = await fetch(LLM_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a dispatch radio analyst. Given multiple machine transcriptions of the same police/fire radio call, extract the single most accurate dispatch summary. Return only valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function normalize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function addressSimilarity(a, b) {
  if (!a || !b) return 0;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const wordsA = new Set(na.split(/\s+/));
  const wordsB = new Set(nb.split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

function sameLocation(a, b) {
  if (a.lat && a.lng && b.lat && b.lng) {
    return haversineKm(a.lat, a.lng, b.lat, b.lng) <= 1.0;
  }
  if (a.address && b.address) {
    return addressSimilarity(a.address, b.address) >= 0.5;
  }
  return false;
}

function clusterEvents(events) {
  const sorted = [...events].sort((a, b) => a.createdAt - b.createdAt);
  const clusters = [];
  for (const event of sorted) {
    let added = false;
    for (const cluster of clusters) {
      const first = cluster[0];
      if (
        Math.abs(event.createdAt - first.createdAt) <= TIME_WINDOW_MS &&
        sameLocation(event, first)
      ) {
        cluster.push(event);
        added = true;
        break;
      }
    }
    if (!added) clusters.push([event]);
  }
  return clusters;
}

function buildPrompt(cluster) {
  let prompt = "Below are multiple automatic transcriptions of the SAME radio dispatch call.\n";
  prompt += "Extract the correct signal type, address, and a clean summary transcript.\n\n";
  cluster.forEach((e, i) => {
    prompt += `--- Feed ${i + 1} (${e.source}) ---\n`;
    prompt += `Signal: ${e.signalType || "unknown"}\n`;
    prompt += `Address: ${e.address || ""}${e.crossStreet ? ` & ${e.crossStreet}` : ""}\n`;
    prompt += `Transcript: ${e.transcript}\n\n`;
  });
  prompt += `Return ONLY JSON in this exact format:\n`;
  prompt += `{\n`;
  prompt += `  "signalType": "...",\n`;
  prompt += `  "address": "...",\n`;
  prompt += `  "crossStreet": "...",\n`;
  prompt += `  "summary": "..."\n`;
  prompt += `}\n`;
  return prompt;
}

async function reconcile() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const eventsCol = db.collection("dispatchEvents");

    const since = new Date(Date.now() - LOOKBACK_MS);
    const events = await eventsCol
      .find({ createdAt: { $gte: since }, source: { $ne: SOURCE_OUTPUT } })
      .sort({ createdAt: 1 })
      .toArray();

    if (events.length === 0) {
      console.log("No events to reconcile.");
      return;
    }

    const clusters = clusterEvents(events);
    console.log(`Found ${clusters.length} clusters. Processing with LLM...`);

    for (const cluster of clusters) {
      const prompt = buildPrompt(cluster);
      let resultText;
      try {
        resultText = await callLlm(prompt);
        const parsed = JSON.parse(resultText.replace(/^```json\n?|\n?```$/g, ""));
        console.log(`LLM result for cluster:`, parsed);

        // TODO: POST parsed result to /api/dispatch with source "DISP 3".
        // See reconciler.mjs for the POST example.
      } catch (err) {
        console.error("LLM processing failed:", err.message);
      }
    }
  } finally {
    await client.close();
  }
}

reconcile().catch((err) => {
  console.error(err);
  process.exit(1);
});
