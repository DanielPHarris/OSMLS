import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Photo and document uploads go through server actions; the default limit is
    // 1 MB. The real limits are enforced in src/lib (8 MB photos, 15 MB documents).
    serverActions: { bodySizeLimit: "20mb" },
  },
  // Pages whose address is itself a secret link (a shared listing, a link to set
  // a password): never stored, never indexed, and never passed on to another site.
  async headers() {
    const secret = [
      { key: "Cache-Control", value: "no-store" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
    ];
    return [
      { source: "/set-password/:path*", headers: secret },
      {
        source: "/share/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
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
