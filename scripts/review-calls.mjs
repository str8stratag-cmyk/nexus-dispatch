import { MongoClient } from "mongodb";
import "dotenv/config";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "dispatch_monitor";

if (!uri) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

const videoPhrases = [
  "thank you for watching",
  "thanks for watching",
  "end of the video",
  "like and subscribe",
  "hello hello hello",
  "what are you reading",
  "today's video",
  "that's the end of",
  "this is just a test",
  "thank you and goodbye",
  "watch your feet",
  "check mark",
  "what were you waiting",
  "we interrupt coursework",
  "your daughter",
  "no answer",
];

const conversationPhrases = [
  "i apologize",
  "pushing back to you",
  "i'd be happy to",
  "have you back on",
  "please make sure you copy",
  "awesome",
  "what are you reading",
];

const nonsensePatterns = [
  "big one three one",
  "hit back",
];

const standaloneJunkWords = ["yeah", "ready", "ok", "okay", "hello"];

const junkAddresses = ["wall", "address unknown", "unknown", "null", "n/a", ""];

function normalize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function containsVideoPhrase(transcript) {
  const t = normalize(transcript);
  return videoPhrases.filter((p) => t.includes(p));
}

function hasRepetitiveWords(transcript) {
  const words = normalize(transcript).split(" ");
  for (let i = 0; i < words.length - 2; i++) {
    if (words[i] && words[i] === words[i + 1] && words[i] === words[i + 2]) {
      return words[i];
    }
  }
  return null;
}

function isJunkAddress(address, crossStreet) {
  const a = normalize(address);
  const c = normalize(crossStreet);
  return junkAddresses.some((j) => a === j || c === j) || (!a && !c);
}

function isConversational(transcript) {
  const t = normalize(transcript);
  const conversationalStarters = ["awesome", "what are you", "yeah that's", "you can pull up", "if you really"];
  return conversationalStarters.filter((p) => t.includes(p));
}

function containsConversationPhrase(transcript) {
  const t = normalize(transcript);
  return conversationPhrases.filter((p) => t.includes(p));
}

function containsNonsensePattern(transcript) {
  const t = normalize(transcript);
  return nonsensePatterns.filter((p) => t.includes(p));
}

function isStandaloneJunk(transcript) {
  const words = normalize(transcript).split(" ").filter(Boolean);
  if (words.length > 2) return null;
  const joined = words.join(" ");
  return standaloneJunkWords.find((w) => joined === w) || null;
}

function scoreEvent(event) {
  let score = 0;
  const reasons = [];

  const videoHits = containsVideoPhrase(event.transcript);
  if (videoHits.length > 0) {
    score += 3;
    reasons.push(`video/TV phrase: "${videoHits[0]}"`);
  }

  const repetitive = hasRepetitiveWords(event.transcript);
  if (repetitive) {
    score += 2;
    reasons.push(`repetitive word: "${repetitive}"`);
  }

  if (isJunkAddress(event.address, event.crossStreet)) {
    score += 2;
    reasons.push(`junk/unknown address: "${event.address || ""}${event.crossStreet ? " & " + event.crossStreet : ""}"`);
  }

  const convHits = isConversational(event.transcript);
  if (convHits.length > 0) {
    score += 2;
    reasons.push(`conversational phrase: "${convHits[0]}"`);
  }

  const conversationHits = containsConversationPhrase(event.transcript);
  if (conversationHits.length > 0) {
    score += 2;
    reasons.push(`phone/TV conversation: "${conversationHits[0]}"`);
  }

  const nonsenseHits = containsNonsensePattern(event.transcript);
  if (nonsenseHits.length > 0) {
    score += 2;
    reasons.push(`nonsense pattern: "${nonsenseHits[0]}"`);
  }

  const junkWord = isStandaloneJunk(event.transcript);
  if (junkWord) {
    score += 2;
    reasons.push(`standalone junk word: "${junkWord}"`);
  }

  const wordCount = normalize(event.transcript).split(" ").filter(Boolean).length;
  if (wordCount > 0 && wordCount < 5 && !event.address) {
    score += 1;
    reasons.push("very short transcript with no address");
  }

  return { score, reasons };
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const eventsCol = db.collection("dispatchEvents");

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const events = await eventsCol
    .find({ createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .toArray();

  console.log(`Reviewed ${events.length} dispatch events from the last 24 hours.\n`);

  const flagged = [];
  for (const event of events) {
    const { score, reasons } = scoreEvent(event);
    if (score >= 3) {
      flagged.push({ event, score, reasons });
    }
  }

  if (flagged.length === 0) {
    console.log("No obviously nonsense calls found.");
  } else {
    console.log(`Flagged ${flagged.length} calls for review:\n`);
    for (const { event, score, reasons } of flagged) {
      console.log(`--- DISPATCH #${event.id} (score ${score}) ---`);
      console.log(`Signal: ${event.signalType || "n/a"}`);
      console.log(`Address: ${event.address || "n/a"}${event.crossStreet ? " & " + event.crossStreet : ""}`);
      console.log(`Transcript: ${event.transcript}`);
      console.log(`Reasons:`);
      for (const r of reasons) {
        console.log(`  - ${r}`);
      }
      console.log("");
    }
  }

  // Summary stats
  const signalTypes = {};
  for (const e of events) {
    signalTypes[e.signalType || "unknown"] = (signalTypes[e.signalType || "unknown"] || 0) + 1;
  }

  console.log("\nSignal type counts:");
  for (const [k, v] of Object.entries(signalTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
} finally {
  await client.close();
}
