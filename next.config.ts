import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Photo and document uploads go through server actions; the default limit is
    // 1 MB. The real limits are enforced in src/lib (8 MB photos, 15 MB documents).
    serverActions: { bodySizeLimit: "20mb" },
  },
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
