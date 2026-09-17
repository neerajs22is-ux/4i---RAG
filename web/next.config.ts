import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives in a subdirectory of a repo that also has a root
  // package-lock.json (the Supabase CLI tooling). Pin the workspace root so
  // Next does not walk up and treat the whole repository as the app.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
