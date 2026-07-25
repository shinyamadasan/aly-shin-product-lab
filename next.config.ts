import type { NextConfig } from "next";
import { inventoryRouteRedirects } from "./src/lib/route-redirects";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async redirects() {
    return inventoryRouteRedirects;
  },
};

export default nextConfig;
