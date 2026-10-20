import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page depends on the signed-in user; nothing here benefits from
  // component caching, and the route handlers must never be cached.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
