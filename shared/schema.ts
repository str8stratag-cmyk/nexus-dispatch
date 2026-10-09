import { z } from "zod";

export interface DispatchEvent {
  id: number;
  transcript: string;
  keywords: string;
  address: string | null;
  crossStreet: string | null;
  lat: number | null;
  lng: number | null;
  signalType: string | null;
  description: string | null;
  district: string;
  source: string;
  status: string;
  isManual: boolean;
  audioUrl: string | null;
  telegramMessageId: string | null;
  geocodedRoad: string | null;
  whisperModel: string | null;
  locationApprox: boolean;
  /** Telegram (or board) acceptor identity when status became accepted. */
  acceptedBy: string | null;
  /** True when the address was recovered from surrounding audio rather than the call's own transcript (verify it). */
  addressFromContext: boolean;
  /** ISO time the call's first/last audio chunk was captured (client hint; null on older clients). */
  audioStartedAt: string | null;
  audioEndedAt: string | null;
  createdAt: string;
}

export interface Setting {
  id: number;
  key: string;
  value: string;
}

export const insertDispatchEventSchema = z.object({
  transcript: z.string(),
  keywords: z.string().default("[]"),
  address: z.string().nullable().optional(),
  crossStreet: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  signalType: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  district: z.string().default("Unknown"),
  source: z.string().default("Unknown"),
  status: z.string().default("active"),
  isManual: z.boolean().default(false),
  audioUrl: z.string().nullable().optional(),
  telegramMessageId: z.string().nullable().optional(),
  geocodedRoad: z.string().nullable().optional(),
  whisperModel: z.string().nullable().optional(),
  locationApprox: z.boolean().default(false),
  acceptedBy: z.string().nullable().optional(),
  // Server-set only: server/routes.ts forces this false on intake and sets it
  // when the address came from contextTranscripts. Persisted.
  addressFromContext: z.boolean().default(false),
  // Client capture-time hints (epoch ms of the call's first/last audio chunk).
  // Clamped server-side; persisted as dates on events and quarantine docs.
  audioStartedAt: z.number().nullable().optional(),
  audioEndedAt: z.number().nullable().optional(),
  // Intake-only (stripped before storage, like skipDedup): neighbouring
  // transcripts the client sends when the call itself has no address, and a
  // per-dispatch id the server uses to ignore a repeated POST.
  contextTranscripts: z.array(z.string().max(500)).max(8).optional(),
  clientRequestId: z.string().max(64).optional(),
  // Intake-only flag: when true, skip the near-duplicate suppression below.
  // Used by the manual entry form so dispatchers can always log a call.
  // Stripped before the event is stored.
  skipDedup: z.boolean().optional(),
});

export const insertSettingsSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export type InsertDispatchEvent = z.infer<typeof insertDispatchEventSchema>;
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
