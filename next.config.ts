import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Composio and the Anthropic SDK are server-only and run fine unbundled.
  serverExternalPackages: ["@composio/core", "@composio/anthropic", "postgres"],
};

export default nextConfig;
