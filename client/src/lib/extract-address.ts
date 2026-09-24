// The extractor lives in shared/ so the server can reuse it for the
// auto-dispatch address backfill (server/routes.ts). Re-exported here to keep
// existing "@/lib/extract-address" imports working.
export * from "@shared/extract-address";
