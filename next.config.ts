import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: allow loading the app from 127.0.0.1 as well as localhost.
  allowedDevOrigins: ["127.0.0.1"],
  // The badge sits on top of the merge bar and corrupts design captures.
  devIndicators: false,
};

export default nextConfig;
