import { config } from "dotenv";
import { MongoClient } from "mongodb";

config();

const sourceUrl = process.env.MIGRATION_SUPABASE_URL;
const sourceKey = process.env.MIGRATION_SUPABASE_SERVICE_ROLE_KEY || process.env.MIGRATION_SUPABASE_ANON_KEY;
const mongoUri = process.env.MONGODB_URI;
const mongoDatabaseName = process.env.MONGODB_DB_NAME || "nexus_dispatch";
const replace = process.argv.includes("--replace");

if (!sourceUrl || !sourceKey || !mongoUri) {
  throw new Error(
    "Set MIGRATION_SUPABASE_URL, MIGRATION_SUPABASE_SERVICE_ROLE_KEY or MIGRATION_SUPABASE_ANON_KEY, and MONGODB_URI before running this script.",
  );
}

async function fetchRows(table: string): Promise<any[]> {
  const rows: any[] = [];
  const pageSize = 1_000;

  for (let start = 0; ; start += pageSize) {
    const response = await fetch(
      `${sourceUrl}/rest/v1/${table}?select=*&order=id.asc`,
      {
        headers: {
          apikey: sourceKey,
          Authorization: `Bearer ${sourceKey}`,
          Range: `${start}-${start + pageSize - 1}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Could not read Supabase ${table}: ${response.status} ${await response.text()}`);
    }

    const page = await response.json() as any[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

const client = new MongoClient(mongoUri);

try {
  await client.connect();
  const database = client.db(mongoDatabaseName);
  const events = database.collection("dispatchEvents");
  const settings = database.collection("settings");
  const counters = database.collection("counters");

  const [eventCount, settingCount] = await Promise.all([
    events.countDocuments(),
    settings.countDocuments(),
  ]);
  if (!replace && (eventCount > 0 || settingCount > 0)) {
    throw new Error(
      "MongoDB already contains dispatch data. Re-run with --replace only if you intend to delete and replace it.",
    );
  }

  if (replace) {
    await Promise.all([
      events.deleteMany({}),
      settings.deleteMany({}),
      counters.deleteMany({}),
    ]);
  }

  const [sourceEvents, sourceSettings] = await Promise.all([
    fetchRows("dispatch_events"),
    fetchRows("settings"),
  ]);

  const migratedEvents = [];
  for (const event of sourceEvents) {
    migratedEvents.push({
      id: event.id,
      transcript: event.transcript,
      keywords: event.keywords,
      address: event.address ?? null,
      crossStreet: event.cross_street ?? null,
      lat: event.lat ?? null,
      lng: event.lng ?? null,
      signalType: event.signal_type ?? null,
      description: event.description ?? null,
      district: event.district,
      source: event.source,
      status: event.status,
      isManual: event.is_manual,
      createdAt: new Date(event.created_at),
    });
  }

  if (migratedEvents.length > 0) {
    await events.insertMany(migratedEvents);
  }
  if (sourceSettings.length > 0) {
    await settings.insertMany(sourceSettings.map((setting) => ({
      id: setting.id,
      key: setting.key,
      value: setting.value,
    })));
  }

  const maxEventId = Math.max(0, ...migratedEvents.map((event) => event.id));
  const maxSettingId = Math.max(0, ...sourceSettings.map((setting) => setting.id));
  await counters.insertMany([
    { _id: "dispatchEvents", sequence: maxEventId },
    { _id: "settings", sequence: maxSettingId },
  ]);

  await Promise.all([
    events.createIndex({ id: 1 }, { unique: true }),
    events.createIndex({ createdAt: -1 }),
    settings.createIndex({ key: 1 }, { unique: true }),
  ]);

  console.log(`Migrated ${migratedEvents.length} events and ${sourceSettings.length} settings to MongoDB.`);
} finally {
  await client.close();
}
