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
    // rehype-sanitize; the remaining headers neuter inline/event-handler XSS
    // where they can and clickjacking if a sanitizer bypass or compromised
    // dep appears.
    //
    // The Content-Security-Policy itself lives in `src/proxy.ts`, not here:
    // it needs a fresh per-request nonce so Next.js's inline hydration
    // scripts are allowed to run. A static policy declared here cannot carry
    // a nonce (and a policy without one blocks all hydration in production).
    //
    // `connect-src` in the proxy allows the Supabase project host (runtime
    // env) plus self; everything else is self-only. No credentials-bearing
    // CORS here.
    return [
      {
        source: "/:path*",
        headers: [
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
