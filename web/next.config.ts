import type { NextConfig } from "next";
import { TEAM_ROUTES, TEAM_SECTIONS } from "./lib/features";

const nextConfig: NextConfig = {
  // A self-contained server in .next/standalone: the desktop app (../desktop) runs it inside Electron.
  output: "standalone",
  // `next dev` blocks its scripts for any host but localhost: without this a tablet on the same network gets the page
  // but it never comes alive.
  allowedDevOrigins: ["10.*.*.*", "192.168.*.*", "172.*.*.*"],
  // proxy.ts makes Next buffer every request body and cut it at 10 MB without an error: a tracks_fixed larger than that
  // was saved truncated (invalid JSON). /api/local/ itself accepts up to 60 MB.
  experimental: { proxyClientMaxBodySize: "100mb" },
  // Hidden sections (lib/features.ts) send to the match list.
  async redirects() {
    return TEAM_SECTIONS ? [] : TEAM_ROUTES.map((source) => ({ source, destination: "/partidos", permanent: false }));
  },
};

export default nextConfig;
