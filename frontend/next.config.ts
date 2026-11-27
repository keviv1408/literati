import type { NextConfig } from "next";

// The Android bundle is a static export that only picks up *.android.tsx routes.
const nextConfig: NextConfig =
  process.env.NEXT_PUBLIC_BUILD_TARGET === 'android'
    ? { output: 'export', pageExtensions: ['android.tsx', 'android.ts'] }
    : {};

export default nextConfig;
