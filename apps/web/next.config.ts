import type { NextConfig } from "next";

// No rewrites and no API routes: the browser talks to the Ircd directly.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Sources import siblings with a ".js" extension (NodeNext style); map it back to TypeScript.
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
