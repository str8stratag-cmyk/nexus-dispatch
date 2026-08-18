import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

export interface OptimizeAudioOptions {
  inputPath: string;
  outputPath: string;
  highPass?: number;
  lowPass?: number;
  sampleRate?: number;
  volume?: string;
}

/**
 * Locate an ffmpeg binary. Prefers a system install, then falls back to
 * ffmpeg-static if it is available as a dependency.
 */
export async function findFfmpeg(): Promise<string> {
  // Prefer system ffmpeg
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-version"]);
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject()));
    });
    return "ffmpeg";
  } catch {
    // fall through to static binary
  }

  // Fall back to ffmpeg-static if installed
  try {
    const ffmpegStatic = await import("ffmpeg-static");
    const staticPath = (ffmpegStatic.default || ffmpegStatic) as string | undefined;
    if (staticPath && typeof staticPath === "string") {
      await access(staticPath);
      return staticPath;
    }
  } catch {
    // ignore
  }

  throw new Error(
    "ffmpeg not found. Install ffmpeg on your system or add ffmpeg-static to dependencies."
  );
}

/**
 * Optimize a police-radio WAV file for AI transcription.
 *
 * Defaults match the recommended chain:
 *   highpass=300 Hz, lowpass=3500 Hz, volume=0dB,
 *   resample to 16000 Hz, mono.
 */
export async function optimizeAudio(options: OptimizeAudioOptions): Promise<void> {
  const {
    inputPath,
    outputPath,
    highPass = 300,
    lowPass = 3500,
    sampleRate = 16000,
    volume = "0dB",
  } = options;

  const ffmpegPath = await findFfmpeg();

  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath,
      "-af", `highpass=f=${highPass},lowpass=f=${lowPass},volume=${volume}`,
      "-ar", String(sampleRate),
      "-ac", "1",
      "-y",
      outputPath,
    ];

    const child = spawn(ffmpegPath, args, { stdio: "inherit" });

    child.on("error", (err) => {
      reject(new Error(`Failed to run ffmpeg: ${err.message}`));
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}
