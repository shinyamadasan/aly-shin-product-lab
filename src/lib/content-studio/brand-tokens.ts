// Content Studio Fast Mode -- the ONE brand token source both creative renderers draw from.
//
// The Satori carousel and the Remotion reel never hard-code a colour, a typeface or a type size: they
// read `spec.brand`, and the spec builder fills `spec.brand` from this object. A still and a video
// built from the same spec therefore cannot disagree about the brand.
//
// The colours are also the Remotion WARM_PALETTE (src/remotion/primitives.tsx derives from this file),
// which follows the Brand Bible's cream / warm white / cocoa brown / coffee brown direction.
// brand_profiles carries no approved hex palette (see supabase-add-brand-foundation-fields.sql), so
// this file is the code authority until one exists.
//
// The older static renderer (src/lib/production-static-renderer.ts) uses a slightly different set of
// hexes. That drift is pre-existing and is not changed here, because doing so would alter an
// already-accepted output.
//
// Typography: Geist, the one face embedded for both engines (src/lib/production-fonts.ts).
// Sizes are pixels on a 1080-wide canvas, which both outputs share (1080x1350 and 1080x1920).
export const ALY_PON_BRAND_TOKENS = {
  name: "Aly & Pon",
  // No approved logo file exists yet, so the mark is a typographic wordmark.
  logo: { kind: "wordmark", text: "aly & pon" },
  color: {
    background: "#F6EFE4",
    foreground: "#2E2117",
    accent: "#B4551F",
    muted: "#8A7250",
    surface: "#EADBC4",
  },
  typography: {
    fontFamily: "Geist",
    weight: { regular: 400, bold: 700 },
    heading: { xl: 112, lg: 84, md: 60 },
    body: { lg: 40, md: 32, sm: 22 },
    lineHeight: { tight: 1.02, normal: 1.3 },
    // Multipliers of the font size, so each renderer turns them into pixels the same way.
    letterSpacing: { tight: -0.02, label: 0.08 },
  },
  spacing: { xs: 12, sm: 24, md: 48, lg: 80, xl: 128 },
  radius: { sm: 8, md: 20, lg: 999 },
} as const;
