// api/_supabase.js
// Server-side Supabase client factory.
// Uses the SERVICE_ROLE key — only import this in Vercel serverless functions,
// never in client-side code.

import { createClient } from "@supabase/supabase-js";

let _client = null;

/**
 * Returns a singleton Supabase admin client (service role).
 * Returns null when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set,
 * so callers can gracefully fall back to default values.
 */
export function getSupabaseAdmin() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
