import { NextResponse, type NextRequest } from "next/server";

/**
 * Request proxy.
 *
 * Generates a per-request CSP nonce so the strict Content-Security-Policy can
 * stay strict (`script-src` has no `'unsafe-inline'`) while Next.js's own
 * inline hydration scripts still execute. Next.js reads the policy from the
 * request headers and attaches the nonce to its framework scripts, page
 * bundles and inline bootstrap scripts automatically; the root layout reads
 * `x-nonce` for the one script the framework does not own (next-themes).
 *
 * The policy is the same directive set the app previously declared in
 * `next.config.ts`; `script-src` gains the nonce and `'strict-dynamic'`
 * because without them every inline script is blocked and the application
 * cannot hydrate (see the D81 follow-up). Using a nonce means pages render
 * per request instead of being statically prerendered; that trade-off is
 * accepted to keep a real, enforcing CSP.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match every request that renders a document, excluding static assets
     * and metadata files. Prefetches are skipped (they return data payloads,
     * not documents) so navigation keeps the documented behaviour.
     */
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|icon.svg|opengraph-image|sitemap.xml|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
