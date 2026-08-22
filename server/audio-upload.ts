import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, parse } from "node:path";
import { randomUUID } from "node:crypto";
import { optimizeAudio } from "./audio-optimizer";
import { storage } from "./storage";
import supabase from "./supabase";
import { transcribeAudio } from "./whisper";

const AUDIO_BUCKET = process.env.AUDIO_STORAGE_BUCKET || "dispatch-audio";

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

function tryParseKeywords(value: unknown): string {
  if (!value || typeof value !== "string") return "[]";
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? value : "[]";
  } catch {
    return "[]";
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

  app.post(
    "/api/audio/upload",
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

        const inputPath = uploadedFile.path;
        const outputName = `${randomUUID()}_optimized.wav`;
        optimizedPath = join(tmpdir(), "dispatch-monitor-uploads", outputName);

        await optimizeAudio({ inputPath, outputPath: optimizedPath });
        const body = req.body || {};
        const transcription = body.transcript?.trim()
          ? null
          : await transcribeOptimizedAudio(optimizedPath);

        // Upload optimized audio to Supabase Storage
        const fileBuffer = await readFile(optimizedPath);
        const storagePath = `audio/${outputName}`;

        const { error: uploadError } = await supabase.storage
          .from(AUDIO_BUCKET)
          .upload(storagePath, fileBuffer, {
            contentType: "audio/wav",
            upsert: false,
          });

        if (uploadError) {
          throw new Error(`Supabase storage upload failed: ${uploadError.message}`);
        }

        const { data: publicUrlData } = supabase.storage
          .from(AUDIO_BUCKET)
          .getPublicUrl(storagePath);

        const audioUrl = publicUrlData?.publicUrl || null;
        // Create the dispatch event
        // Create the dispatch event
        const event = await storage.createEvent({
          transcript: body.transcript?.trim() || transcription?.text || "Audio upload",
          keywords: tryParseKeywords(body.keywords),
          address: body.address || null,
          crossStreet: body.crossStreet || null,
          lat: body.lat ? Number(body.lat) : null,
          lng: body.lng ? Number(body.lng) : null,
          signalType: body.signalType || null,
          description: body.description || null,
          district: body.district || "Unknown",
          source: body.source || "Audio Upload",
          status: "active",
          isManual: true,
          audioUrl,
        });

        res.status(201).json({ event, audioUrl });
      } catch (err: any) {
        console.error("Audio upload failed:", err);
        res.status(500).json({ message: err.message || "Audio upload failed" });
      } finally {
        await safeUnlink(uploadedFile?.path);
        await safeUnlink(optimizedPath);
      }
    }
  );
}
