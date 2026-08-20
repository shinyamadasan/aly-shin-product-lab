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
  // The other half of externalizing a native module, and the half that only fails once deployed.
  //
  // serverExternalPackages stops these being BUNDLED. What ships them to the serverless function is
  // Next's output file tracing, which walks static require/import calls. sharp's platform binding is
  // reached that way and traces fine -- but the binding then dlopen()s libvips-cpp.so at RUNTIME,
  // and a runtime dlopen is invisible to a static tracer. The .so was therefore left behind, and the
  // first live request to /api/production died on module load, before a single line of route code:
  //
  //   Could not load the "sharp" module using the linux-x64 runtime
  //   ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3: cannot open shared object file
  //
  // It failed identically on every request, authenticated or not, in ~7ms -- nowhere near Cloudflare
  // and nowhere near the renderer. Locally it never reproduced, because a local node_modules has the
  // whole package on disk and nothing is traced at all.
  //
  // Keyed per ROUTE because that is the granularity this config accepts, and these two routes are
  // the only places the production executors run.
  //
  // The globs are linux-x64 ONLY, and deliberately so: this is describing what must be present in the
  // Vercel function, not on a developer's machine. They match nothing when building on Windows or
  // macOS, which is correct and harmless -- tracing that matters happens during the Linux build.
  //
  // @resvg/resvg-js is listed alongside sharp even though it has not failed yet. It is the same kind
  // of externalized native module and had not been reached only because sharp crashed first; leaving
  // it out risks a second identical deploy failure for a second identical reason.
  outputFileTracingIncludes: {
    "/api/production": [
      "./node_modules/@img/sharp-libvips-linux-x64/**/*",
      "./node_modules/@img/sharp-linux-x64/**/*",
      "./node_modules/@resvg/resvg-js-linux-x64-gnu/**/*",
    ],
    "/api/production/manual": [
      "./node_modules/@img/sharp-libvips-linux-x64/**/*",
      "./node_modules/@img/sharp-linux-x64/**/*",
      "./node_modules/@resvg/resvg-js-linux-x64-gnu/**/*",
    ],
  },
  async redirects() {
    return inventoryRouteRedirects;
  },
};

export default nextConfig;
