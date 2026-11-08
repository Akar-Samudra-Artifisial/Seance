import type { NextConfig } from "next";

// pixel-match R13.4/R13.5 (D11): the fixture route (`*.fixture.tsx` pages) exists only in a build
// made with SEANCE_E2E_FIXTURES=1. That build goes to its own distDir (SEANCE_DIST_DIR, e.g.
// `.next-e2e`), so the normal `.next` output never contains fixture code.
const fixtures = process.env["SEANCE_E2E_FIXTURES"] === "1";
const distDir = process.env["SEANCE_DIST_DIR"];
if (distDir !== undefined && !/^\.next[\w-]*$/.test(distDir)) {
  throw new Error(`SEANCE_DIST_DIR must be a .next* directory inside apps/web, got "${distDir}"`);
}

// No rewrites and no API routes: the browser talks to the Ircd directly.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  pageExtensions: fixtures ? ["fixture.tsx", "tsx", "ts", "jsx", "js"] : ["tsx", "ts", "jsx", "js"],
  ...(distDir === undefined ? {} : { distDir }),
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
