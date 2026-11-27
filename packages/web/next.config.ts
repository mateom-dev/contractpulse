import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The repository runs ESLint once from the root (`pnpm lint`).
  eslint: { ignoreDuringBuilds: true },
};

export default config;
