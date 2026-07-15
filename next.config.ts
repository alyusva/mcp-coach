import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Python serverless functions live in /api at the root.
  // Vercel handles them via vercel.json — no conflict with Next.js App Router.
};

export default nextConfig;
