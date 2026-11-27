import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    FRONTEND_URL: process.env.FRONTEND_URL ? new URL(process.env.FRONTEND_URL).origin : '',
  },
  ...(process.env.NEXT_PUBLIC_BUILD_TARGET === 'android'
    ? { output: 'export', pageExtensions: ['android.tsx', 'android.ts'] }
    : {}),
};

export default nextConfig;
