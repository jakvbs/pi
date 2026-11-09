import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { findPackageJSON } from "module";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const configDir = dirname(fileURLToPath(import.meta.url));
// pi-web lives in the pi fork's npm workspace as apps/web, and npm hoists its
// dependencies, next and the SDK included, to the fork's root.
const workspaceRoot = join(configDir, "..", "..");
const { version } = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = findPackageJSON("@earendil-works/pi-coding-agent", pathToFileURL(join(configDir, "package.json")).href);
  if (piPkgPath) piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

// mdast-util-gfm-autolink-literal (remark-gfm) ships a RegExp lookbehind that
// Safari parses only from 16.4, which blanked `/` on iOS 16.2 (#753). The loader
// swaps it for an equivalent built at runtime; both bundlers must run it.
const gfmAutolinkEmailLoader = join(configDir, "lib/gfm-autolink-email-loader.cjs");

// The pi packages are npm workspace links to the fork's packages/*, whose real
// paths lie outside node_modules, so Turbopack bundles them despite
// serverExternalPackages. On the server each entry pi-web imports goes to a
// stub that require()s it at run time, where bin/dev-fork.js's resolver hook loads the
// fork's source, the one copy the SDK's own modules share. The browser bundle
// imports one pi module, compiled from that source.
const piRuntimeAliases = {
  "@earendil-works/pi-coding-agent": "./lib/pi-runtime/pi-coding-agent.cjs",
  "@earendil-works/pi-agent-core": "./lib/pi-runtime/pi-agent-core.cjs",
  "@earendil-works/pi-ai": "./lib/pi-runtime/pi-ai.cjs",
  "@earendil-works/pi-ai/compat": "./lib/pi-runtime/pi-ai-compat.cjs",
  "@earendil-works/pi-ai/providers/all": "./lib/pi-runtime/pi-ai-providers-all.cjs",
  "@earendil-works/pi-ai/utils/json-parse": {
    browser: "../../packages/ai/src/utils/json-parse.ts",
    default: "./lib/pi-runtime/pi-ai-utils-json-parse.cjs",
  },
  "@earendil-works/pi-mcp": "./lib/pi-runtime/pi-mcp.cjs",
  "@earendil-works/pi-mcp/oauth": "./lib/pi-runtime/pi-mcp-oauth.cjs",
  "@earendil-works/pi-tui": "./lib/pi-runtime/pi-tui.cjs",
};

const nextConfig: NextConfig = {
  outputFileTracingRoot: workspaceRoot,
  experimental: {
    // proxy.ts matches /api/:path*, and Next buffers the request body whenever
    // a proxy is present, capped at 10 MB by default. The upload route accepts
    // up to 100 MB per request, so raise the buffer above that or large uploads
    // are truncated and fail with "Failed to parse body as FormData."
    proxyClientMaxBodySize: "128mb",
  },
  // next/image is only used for the static logo, so the /_next/image optimizer
  // (and its sharp/libheif attack surface, see GHSA-2xp9-vwfh-vxw4) is not needed.
  images: { unoptimized: true },
  // `next dev` runs Turbopack and `npm run build` runs webpack.
  turbopack: {
    root: workspaceRoot,
    resolveAlias: piRuntimeAliases,
    rules: {
      "**/mdast-util-gfm-autolink-literal/lib/index.js": { loaders: [gfmAutolinkEmailLoader] },
    },
  },
  webpack(config) {
    config.module.rules.push({
      test: /[\\/]mdast-util-gfm-autolink-literal[\\/]lib[\\/]index\.js$/,
      loader: gfmAutolinkEmailLoader,
    });
    return config;
  },
  // Node modules keep the syntax they ship unless listed here, and mermaid's
  // lazy diagram chunks are full of class `static {}` blocks (#753).
  transpilePackages: ["mermaid", "@mermaid-js/parser"],
  serverExternalPackages: [
    "node-pty",
    "undici",
    "web-push",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-mcp",
    "@earendil-works/pi-tui",
  ],
  // Next 16 blocks cross-origin access to dev resources by default. Allow the
  // loopback and the RFC1918 LAN ranges so the dev server stays reachable
  // from other machines on the same LAN.
  allowedDevOrigins: [
    "127.0.0.1",
    "10.*.*.*",
    // 172.16.0.0/12
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
  ],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
