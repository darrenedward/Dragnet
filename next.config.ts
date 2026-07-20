import type { NextConfig } from "next";

const outputTraceExcludes = [
  "./.dragnet/**/*",
  "./.env*",
  "./cli/**/*",
  "./deployment/**/*",
  "./docs/**/*",
  "./scripts/**/*",
  "./src/**/*",
  "./tests/**/*",
  "./*.db",
  "./*.md",
  "./Dockerfile",
  "./docker-compose.yml",
  "./metadata.json",
  "./next.config.ts",
  "./opencode.json*",
  "./postcss.config.mjs",
  "./prisma/**/*",
  "./tsconfig*.json",
  "./tsconfig.tsbuildinfo",
  "./vitest.config.ts",
];

const nextConfig: NextConfig = {
  outputFileTracingExcludes: {
    "/*": outputTraceExcludes,
  },
};

export default nextConfig;
