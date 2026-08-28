import type { DispatchEvent, InsertDispatchEvent, Setting, InsertSettings } from '@shared/schema';
import { DEFAULT_KEYWORDS, type KeywordEntry } from '@shared/keywords';
import { getDatabase } from "./mongodb";

const KEYWORD_LIST_SETTING_KEY = "keyword_list";

interface DispatchEventDocument {
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
  createdAt: Date;
}

interface SettingDocument {
  id: number;
  key: string;
  value: string;
}

function mapEvent(row: DispatchEventDocument): DispatchEvent {
  return {
    id: row.id,
    transcript: row.transcript,
    keywords: row.keywords,
    address: row.address,
    crossStreet: row.crossStreet,
    lat: row.lat,
    lng: row.lng,
    signalType: row.signalType,
    description: row.description,
    district: row.district,
    source: row.source,
    status: row.status,
    isManual: row.isManual,
    audioUrl: row.audioUrl,
    telegramMessageId: row.telegramMessageId,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapSetting(row: SettingDocument): Setting {
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
  private async nextId(collection: "dispatchEvents" | "settings"): Promise<number> {
    const database = await getDatabase();
    const counter = await database.collection<{ _id: string; sequence: number }>("counters").findOneAndUpdate(
      { _id: collection },
      { $inc: { sequence: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    if (!counter) throw new Error(`Could not allocate an ID for ${collection}`);
    return counter.sequence;
  }

  async getEvents(): Promise<DispatchEvent[]> {
    const database = await getDatabase();
    const events = await database.collection<DispatchEventDocument>("dispatchEvents")
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    return events.map(mapEvent);
  }

  async getEvent(id: number): Promise<DispatchEvent | undefined> {
    const database = await getDatabase();
    const event = await database.collection<DispatchEventDocument>("dispatchEvents").findOne({ id });
    return event ? mapEvent(event) : undefined;
  }

  async createEvent(event: InsertDispatchEvent): Promise<DispatchEvent> {
    const database = await getDatabase();
    const document: DispatchEventDocument = {
      id: await this.nextId("dispatchEvents"),
      transcript: event.transcript,
      keywords: event.keywords ?? "[]",
      address: event.address ?? null,
      crossStreet: event.crossStreet ?? null,
      lat: event.lat ?? null,
      lng: event.lng ?? null,
      signalType: event.signalType ?? null,
      description: event.description ?? null,
      district: event.district ?? "Unknown",
      source: event.source ?? "Unknown",
      status: event.status ?? "active",
      isManual: event.isManual ?? false,
      audioUrl: event.audioUrl ?? null,
      telegramMessageId: event.telegramMessageId ?? null,
      createdAt: new Date(),
    };
    await database.collection<DispatchEventDocument>("dispatchEvents").insertOne(document);
    return mapEvent(document);
  }

  async updateEventStatus(id: number, status: string): Promise<DispatchEvent | undefined> {
    const database = await getDatabase();
    const event = await database.collection<DispatchEventDocument>("dispatchEvents").findOneAndUpdate(
      { id },
      { $set: { status } },
      { returnDocument: "after" },
    );
    return event ? mapEvent(event) : undefined;
  }

  async getSetting(key: string): Promise<Setting | undefined> {
    const database = await getDatabase();
    const setting = await database.collection<SettingDocument>("settings").findOne({ key });
    return setting ? mapSetting(setting) : undefined;
  }

  async upsertSetting(setting: InsertSettings): Promise<Setting> {
    const database = await getDatabase();
    const document = await database.collection<SettingDocument>("settings").findOneAndUpdate(
      { key: setting.key },
      {
        $set: { value: setting.value },
        $setOnInsert: { id: await this.nextId("settings") },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (!document) throw new Error(`Could not save setting "${setting.key}"`);
    return mapSetting(document);
  }

  async getAllSettings(): Promise<Setting[]> {
    const database = await getDatabase();
    const settings = await database.collection<SettingDocument>("settings").find().sort({ key: 1 }).toArray();
    return settings.map(mapSetting);
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
