import { resolveWhisperTarget } from "./whisper-failover";

// process.env.WHISPER_SERVICE_URL is a legacy direct override (bypasses
// failover entirely, same as before this existed); otherwise resolved
// dynamically per call so a watchdog-driven local/remote switch takes
// effect without a server restart.
const WHISPER_API_KEY = process.env.WHISPER_API_KEY;
function getWhisperServiceUrl(): string {
  return process.env.WHISPER_SERVICE_URL || resolveWhisperTarget();
}

interface WhisperResponse {
  text: string;
  language: string;
  duration: number;
  model?: string;
}

export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  keywords: string[]
): Promise<WhisperResponse> {
  // Keep this prompt generic. Whisper treats initial_prompt as prior context and
  // will hallucinate a concrete call example into unrelated audio — a hardcoded
  // "Signal 4, MVA at Dale Mabry and Linebaugh" example caused ~330 bogus events
  // over one weekend (see client hook fix; 2026-09-08).
  const prompt = keywords.length
    ? `Dispatch radio terminology: ${keywords.slice(0, 8).join(", ")}.`
    : "Dispatch radio terminology.";
  const body = new FormData();
  body.set("audio", new Blob([audio]), filename);
  body.set("prompt", prompt);

  const whisperServiceUrl = getWhisperServiceUrl();
  let response: Response;
  try {
    response = await fetch(`${whisperServiceUrl}/transcribe`, {
      method: "POST",
      body,
      headers: WHISPER_API_KEY ? { "X-Whisper-Key": WHISPER_API_KEY } : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(
      `Whisper service is unavailable at ${whisperServiceUrl}. Start it with "npm run whisper:start".`
    );
  }

  if (!response.ok) {
    throw new Error(`Whisper transcription failed: ${await response.text()}`);
  }

  const result = await response.json() as Partial<WhisperResponse>;
  if (typeof result.text !== "string") {
    throw new Error("Local Whisper service returned an invalid transcription response.");
  }

  return {
    text: result.text,
    language: typeof result.language === "string" ? result.language : "en",
    duration: typeof result.duration === "number" ? result.duration : 0,
    model: typeof result.model === "string" ? result.model : undefined,
  };
}

// Cached model name of the Whisper service (from /health). Used to stamp
// dispatch events with which model produced them (fleet accuracy comparison).
// Keyed off the resolved URL so a watchdog failover (local <-> remote, which
// typically also means a different model, e.g. small.en vs. medium.en) never
// serves a stale model name from the side that answered before the switch.
let cachedWhisperModel: string | undefined;
let cachedWhisperModelUrl: string | undefined;
let whisperModelPromise: Promise<string | undefined> | undefined;

export function getWhisperModel(): Promise<string | undefined> {
  const whisperServiceUrl = getWhisperServiceUrl();
  if (cachedWhisperModel && cachedWhisperModelUrl === whisperServiceUrl) {
    return Promise.resolve(cachedWhisperModel);
  }
  if (cachedWhisperModelUrl !== whisperServiceUrl) {
    // Target changed since the last successful lookup: drop any in-flight
    // promise for the old target too, not just the cached value.
    cachedWhisperModel = undefined;
    whisperModelPromise = undefined;
  }
  whisperModelPromise ??= fetch(`${whisperServiceUrl}/health`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => (res.ok ? res.json() : undefined))
    .then((health: { model?: string } | undefined) => {
      cachedWhisperModel = typeof health?.model === "string" ? health.model : undefined;
      cachedWhisperModelUrl = cachedWhisperModel ? whisperServiceUrl : undefined;
      return cachedWhisperModel;
    })
    .catch(() => undefined)
    .finally(() => {
      // Don't cache a failed/empty lookup — otherwise one /health timeout
      // (known to happen mid-transcription) poisons whisperModel on every
      // event for the rest of the process's life. Match getDatabase()'s
      // reset-on-failure pattern in mongodb.ts.
      if (!cachedWhisperModel) whisperModelPromise = undefined;
    });
  return whisperModelPromise;
}
