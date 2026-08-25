import { Db, MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB_NAME || "nexus_dispatch";

export const isMongoConfigured = Boolean(uri);

let databasePromise: Promise<Db> | undefined;

export function getDatabase(): Promise<Db> {
  if (!uri) {
    throw new Error("MONGODB_URI is not set. Database-backed routes are unavailable.");
  }

  if (!databasePromise) {
    databasePromise = MongoClient.connect(uri).then(async (client) => {
      const database = client.db(databaseName);
      await Promise.all([
        database.collection("dispatchEvents").createIndex({ id: 1 }, { unique: true }),
        database.collection("dispatchEvents").createIndex({ createdAt: -1 }),
        database.collection("settings").createIndex({ key: 1 }, { unique: true }),
      ]);
      return database;
    });
  }

  return databasePromise;
}
