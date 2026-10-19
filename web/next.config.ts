import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server in .next/standalone: the desktop app (../desktop) runs it inside Electron.
  output: "standalone",
};

export default nextConfig;
