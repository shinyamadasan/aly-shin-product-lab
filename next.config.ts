import type { NextConfig } from "next";
import { inventoryRouteRedirects } from "./src/lib/route-redirects";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // Production MVP Wave B. The static renderer is not ordinary JavaScript and must not be bundled.
  //
  // @resvg/resvg-js is a native .node binding ("non-ecmascript placeable asset" to the bundler) and
  // sharp is likewise native; bundling either fails the build outright.
  //
  // The FONTS are deliberately NOT in this list. Externalizing @fontsource/geist-sans still did not
  // make a require.resolve subpath real inside a Next server chunk -- the first live owner-facing run
  // died on an "[externals]/..." ENOENT -- so the faces are embedded as base64 in
  // src/lib/production-fonts.ts and need no resolution at all.
  //
  // serverExternalPackages is Next's own supported answer: these stay external and are required from
  // node_modules inside the Node runtime, which is exactly where the production route runs. It also
  // keeps them out of the client graph entirely.
  serverExternalPackages: ["@resvg/resvg-js", "sharp", "satori"],
  async redirects() {
    return inventoryRouteRedirects;
  },
};

export default nextConfig;
