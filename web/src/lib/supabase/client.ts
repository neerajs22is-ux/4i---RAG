import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client.
 *
 * Uses the publishable (anon) key only — this is the public, browser-safe key.
 * Service-role keys, provider keys and worker secrets must never reach the
 * frontend. Access is constrained by Row Level Security and every model call
 * goes through the Edge Functions.
 *
 * The client is created lazily and cached: constructing it during render is
 * safe, but we avoid doing work when the env is not configured (e.g. a machine
 * running only the backend, or CI).
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** True when the browser-safe environment is present. */
export const isSupabaseConfigured = Boolean(url && anonKey);

let cached: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error("Supabase environment is not configured");
  }
  cached ??= createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // No OAuth / magic-link callback lives in this app yet.
      detectSessionInUrl: false,
    },
  });
  return cached;
}

/** Project origin without credentials, for building Edge Function URLs. */
export function getSupabaseUrl(): string {
  if (!url) throw new Error("Supabase environment is not configured");
  return url.replace(/\/+$/, "");
}

/** The publishable key, sent as the `apikey` header on Edge Function calls. */
export function getSupabaseAnonKey(): string {
  if (!anonKey) throw new Error("Supabase environment is not configured");
  return anonKey;
}
