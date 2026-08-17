import type { DispatchEvent, InsertDispatchEvent, Setting, InsertSettings } from '@shared/schema';
import { DEFAULT_KEYWORDS, type KeywordEntry } from '@shared/keywords';
import supabase from "./supabase";

const KEYWORD_LIST_SETTING_KEY = "keyword_list";

// Maps a Postgres row (snake_case) to the app-facing shape (camelCase)
function mapEvent(row: any): DispatchEvent {
  return {
    id: row.id,
    transcript: row.transcript,
    keywords: row.keywords,
    address: row.address,
    crossStreet: row.cross_street ?? null,
    lat: row.lat,
    lng: row.lng,
    signalType: row.signal_type,
    description: row.description,
    district: row.district,
    source: row.source,
    status: row.status,
    isManual: row.is_manual,
    createdAt: row.created_at,
  };
}

function mapSetting(row: any): Setting {
  return { id: row.id, key: row.key, value: row.value };
}

export interface IStorage {
  // Dispatch events
  getEvents(): Promise<DispatchEvent[]>;
  getEvent(id: number): Promise<DispatchEvent | undefined>;
  createEvent(event: InsertDispatchEvent): Promise<DispatchEvent>;
  updateEventStatus(id: number, status: string): Promise<DispatchEvent | undefined>;
  // Settings
  getSetting(key: string): Promise<Setting | undefined>;
  upsertSetting(setting: InsertSettings): Promise<Setting>;
  getAllSettings(): Promise<Setting[]>;
  // Keywords / homophones
  getKeywords(): Promise<KeywordEntry[]>;
  addKeyword(entry: KeywordEntry): Promise<KeywordEntry[]>;
  removeKeyword(pattern: string): Promise<KeywordEntry[]>;
}

export class DatabaseStorage implements IStorage {
  async getEvents(): Promise<DispatchEvent[]> {
    const { data, error } = await supabase
      .from("dispatch_events")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map(mapEvent);
  }

  async getEvent(id: number): Promise<DispatchEvent | undefined> {
    const { data, error } = await supabase
      .from("dispatch_events")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapEvent(data) : undefined;
  }

  async createEvent(event: InsertDispatchEvent): Promise<DispatchEvent> {
    const { data, error } = await supabase
      .from("dispatch_events")
      .insert({
        transcript: event.transcript,
        keywords: event.keywords ?? "[]",
        address: event.address ?? null,
        cross_street: event.crossStreet ?? null,
        lat: event.lat ?? null,
        lng: event.lng ?? null,
        signal_type: event.signalType ?? null,
        description: event.description ?? null,
        district: event.district ?? "Unknown",
        source: event.source ?? "Unknown",
        status: event.status ?? "active",
        is_manual: event.isManual ?? false,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return mapEvent(data);
  }

  async updateEventStatus(id: number, status: string): Promise<DispatchEvent | undefined> {
    const { data, error } = await supabase
      .from("dispatch_events")
      .update({ status })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapEvent(data) : undefined;
  }

  async getSetting(key: string): Promise<Setting | undefined> {
    const { data, error } = await supabase
      .from("settings")
      .select("*")
      .eq("key", key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapSetting(data) : undefined;
  }

  async upsertSetting(setting: InsertSettings): Promise<Setting> {
    const { data, error } = await supabase
      .from("settings")
      .upsert({ key: setting.key, value: setting.value }, { onConflict: "key" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return mapSetting(data);
  }

  async getAllSettings(): Promise<Setting[]> {
    const { data, error } = await supabase.from("settings").select("*");
    if (error) throw new Error(error.message);
    return (data || []).map(mapSetting);
  }

  async getKeywords(): Promise<KeywordEntry[]> {
    const existing = await this.getSetting(KEYWORD_LIST_SETTING_KEY);
    if (!existing) {
      // First run — seed persistent storage with the built-in defaults so
      // future add/remove edits have something concrete to operate on.
      await this.upsertSetting({ key: KEYWORD_LIST_SETTING_KEY, value: JSON.stringify(DEFAULT_KEYWORDS) });
      return DEFAULT_KEYWORDS;
    }
    try {
      const parsed = JSON.parse(existing.value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to defaults on corrupt data
    }
    return DEFAULT_KEYWORDS;
  }

  async addKeyword(entry: KeywordEntry): Promise<KeywordEntry[]> {
    const current = await this.getKeywords();
    if (current.some((k) => k.pattern === entry.pattern)) {
      throw new Error(`Keyword pattern "${entry.pattern}" already exists`);
    }
    const updated = [...current, entry];
    await this.upsertSetting({ key: KEYWORD_LIST_SETTING_KEY, value: JSON.stringify(updated) });
    return updated;
  }

  async removeKeyword(pattern: string): Promise<KeywordEntry[]> {
    const current = await this.getKeywords();
    const updated = current.filter((k) => k.pattern !== pattern);
    await this.upsertSetting({ key: KEYWORD_LIST_SETTING_KEY, value: JSON.stringify(updated) });
    return updated;
  }
}

export const storage = new DatabaseStorage();
