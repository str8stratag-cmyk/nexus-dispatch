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
});

export const insertSettingsSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export type InsertDispatchEvent = z.infer<typeof insertDispatchEventSchema>;
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
