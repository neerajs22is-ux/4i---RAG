// Shared CORS for the browser-facing Edge Functions (ask, query-chunks, ingest-pdf).
//
// CORS is a browser control, not an authorization boundary. Every function that
// uses this module still requires the caller's JWT (`verify_jwt` on at the
// gateway, plus an explicit `auth.getUser` check) and re-checks tenant
// membership; PostgreSQL RLS remains the data boundary. This module deliberately
// never sends `Access-Control-Allow-Credentials`, and the API never relies on
// cookies, so a page from another origin cannot ride an ambient session — it
// would still need the user's bearer token.
//
// By default the request Origin is echoed (and `Vary: Origin` is set so caches
// cannot serve one origin's response to another). Setting the optional
// `CORS_ALLOWED_ORIGINS` secret (comma-separated) narrows it to an allow-list:
// a non-listed origin receives a header it cannot use, so the browser blocks it.
//
// `embed-worker` is cron-invoked, not browser-facing, and does not use this.

const ALLOWED_ORIGINS: string[] = (Deno.env.get("CORS_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  // L-1: never emit a wildcard when a browser Origin is present. With no
  // allow-list configured only https origins (plus localhost http for local
  // dev) are echoed; anything else gets no usable origin so the browser
  // blocks it. Non-browser calls (no Origin) keep "*" — harmless without
  // credentials, which are never used.
  let allowOrigin: string;
  if (ALLOWED_ORIGINS.length > 0) {
    allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  } else if (!origin) {
    allowOrigin = "*";
  } else if (
    origin.startsWith("https://") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1")
  ) {
    allowOrigin = origin;
  } else {
    allowOrigin = "https://4i-rag.vercel.app";
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/** 204 response for a CORS preflight, or null when the request is not one. */
export function corsPreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
