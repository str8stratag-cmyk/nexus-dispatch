import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { optimizeAudio } from "./audio-optimizer";
import { storage } from "./storage";
import { transcribeAudio } from "./whisper";

const upload = multer({
  dest: join(tmpdir(), "dispatch-monitor-uploads"),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("audio/") || extname(file.originalname).toLowerCase() === ".wav") {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are allowed"));
    }
  },
});

async function ensureUploadDir(): Promise<void> {
  await mkdir(join(tmpdir(), "dispatch-monitor-uploads"), { recursive: true });
}

async function safeUnlink(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

async function transcribeOptimizedAudio(path: string) {
  const [audio, keywords] = await Promise.all([
    readFile(path),
    storage.getKeywords(),
  ]);
  return transcribeAudio(audio, "dispatch.wav", keywords.map((keyword) => keyword.pattern));
}

export function registerAudioUploadRoutes(app: Express): void {
  app.post(
    "/api/audio/transcribe",
    (req, res, next) => {
      ensureUploadDir().then(() => next()).catch(next);
    },
    upload.single("audio"),
    async (req: Request, res: Response, _next: NextFunction) => {
      const uploadedFile = req.file;
      let optimizedPath: string | undefined;

      try {
        if (!uploadedFile) {
          return res.status(400).json({ message: "No audio file provided (expected field: 'audio')" });
        }

        optimizedPath = join(tmpdir(), "dispatch-monitor-uploads", `${randomUUID()}_transcription.wav`);
        await optimizeAudio({ inputPath: uploadedFile.path, outputPath: optimizedPath });
        res.json(await transcribeOptimizedAudio(optimizedPath));
      } catch (err: any) {
        console.error("Audio transcription failed:", err);
        res.status(503).json({ message: err.message || "Audio transcription failed" });
      } finally {
        await safeUnlink(uploadedFile?.path);
        await safeUnlink(optimizedPath);
      }
    }
  );
}
