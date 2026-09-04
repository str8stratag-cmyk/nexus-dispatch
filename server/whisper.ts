const WHISPER_SERVICE_URL = process.env.WHISPER_SERVICE_URL || "http://127.0.0.1:8178";
const WHISPER_API_KEY = process.env.WHISPER_API_KEY;

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
  const prompt = keywords.length
    ? `Dispatch radio: Signal 4, MVA at Dale Mabry and Linebaugh. Unit responding. ${keywords.slice(0, 8).join(", ")}.`
    : "Dispatch radio: Signal 4, MVA at Dale Mabry and Linebaugh. Unit responding.";
  const body = new FormData();
  body.set("audio", new Blob([audio]), filename);
  body.set("prompt", prompt);

  let response: Response;
  try {
    response = await fetch(`${WHISPER_SERVICE_URL}/transcribe`, {
      method: "POST",
      body,
      headers: WHISPER_API_KEY ? { "X-Whisper-Key": WHISPER_API_KEY } : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(
      `Local Whisper service is unavailable at ${WHISPER_SERVICE_URL}. Start it with "npm run whisper:start".`
    );
  }

  if (!response.ok) {
    throw new Error(`Local Whisper transcription failed: ${await response.text()}`);
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

// Cached model name of the local Whisper service (from /health). Used to stamp
// dispatch events with which model produced them (fleet accuracy comparison).
let cachedWhisperModel: string | undefined;
let whisperModelPromise: Promise<string | undefined> | undefined;

export function getWhisperModel(): Promise<string | undefined> {
  if (cachedWhisperModel) return Promise.resolve(cachedWhisperModel);
  whisperModelPromise ??= fetch(`${WHISPER_SERVICE_URL}/health`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => (res.ok ? res.json() : undefined))
    .then((health: { model?: string } | undefined) => {
      cachedWhisperModel = typeof health?.model === "string" ? health.model : undefined;
      return cachedWhisperModel;
    })
    .catch(() => undefined);
  return whisperModelPromise;
}
