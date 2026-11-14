import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Composio and the Anthropic SDK are server-only and run fine unbundled.
  serverExternalPackages: ["@composio/core", "@composio/anthropic", "postgres"],
  // SOP uploads (PDFs) go through server actions. Vercel caps request bodies at 4.5 MB.
  experimental: { serverActions: { bodySizeLimit: "4.5mb" } },
};

export default nextConfig;
