const WHISPER_SERVICE_URL = process.env.WHISPER_SERVICE_URL || "http://127.0.0.1:8178";
const WHISPER_API_KEY = process.env.WHISPER_API_KEY;

interface WhisperResponse {
  text: string;
  language: string;
  duration: number;
}

export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  keywords: string[]
): Promise<WhisperResponse> {
  // Keep this prompt generic. Whisper treats initial_prompt as prior context and
  // will hallucinate a concrete call example into unrelated audio — the previous
  // hardcoded "Signal 4, MVA at Dale Mabry and Linebaugh" caused ~330 bogus
  // events over one weekend (same fix as dispatch-monitor, 2026-09-08).
  const prompt = keywords.length
    ? `Dispatch radio terminology: ${keywords.slice(0, 8).join(", ")}.`
    : "Dispatch radio terminology.";
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
  };
}
