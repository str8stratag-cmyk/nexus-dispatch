import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && key);

if (!isSupabaseConfigured) {
  // Do NOT throw here — a top-level throw during module load crashes the
  // process before Express can bind to the port, which surfaces as a
  // permanent 503 from the proxy with no diagnosable error. Instead, log
  // loudly and let requests fail individually so /api/health can report
  // the real cause.
  console.error(
    "[supabase] SUPABASE_URL and/or SUPABASE_ANON_KEY are not set in this environment. All database-backed routes will fail until this is fixed."
  );
}

// Node 20 has no native WebSocket global that the Supabase realtime client
// expects; we don't use realtime subscriptions here, but the client still
// initializes one on construction, so provide the `ws` transport explicitly.
const supabase = createClient(
  url || "https://placeholder.invalid",
  key || "placeholder-key",
  {
    realtime: {
      transport: ws as any,
    },
  }
);

export default supabase;
