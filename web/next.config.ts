import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives in a subdirectory of a repo that also has a root
  // package-lock.json (the Supabase CLI tooling). Pin the workspace root so
  // Next does not walk up and treat the whole repository as the app.
  turbopack: {
    root: __dirname,
  },
  // Security hardening (M-8/L-14): no version banner, no browser source maps.
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  async headers() {
    // Defense-in-depth. Primary XSS barrier remains React escaping +
    // rehype-sanitize; CSP/frame-ancestors neuter inline/event-handler XSS
    // and clickjacking if a sanitizer bypass or compromised dep appears.
    // connect-src must allow the Supabase project host (runtime env) plus
    // self; everything else is self-only. No credentials-bearing CORS here.
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
