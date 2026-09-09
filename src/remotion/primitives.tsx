import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

import { REMOTION_FONT_STACK } from "./fonts.ts";
import { windowEnd, type TimingWindow } from "./timing.ts";

// Production MVP Wave C1 -- the motion primitives, and only the ones the first composition earns.
//
// There are four. That is not a stopping point chosen for tidiness: every element in warm-open.tsx
// is built from these, and nothing here exists that warm-open.tsx does not use. A fifth transition
// added "for later" would be an animation library nothing had asked for, and Wave C's whole premise
// is that a strong idea executed intentionally beats a large kit executed generically.
//
// WHAT IS DELIBERATELY ABSENT
//
// No cuts. No wipes. No spring overshoot. No rotation. No parallax. No exit animations at all -- the
// creative direction is that things arrive and then stay, and a primitive that removed something
// from frame would be the first step away from that.
//
// EVERY interpolate() CALL BELOW IS INLINE IN A style PROP, per the official Remotion markup
// guidance, and every one clamps both ends. Clamping is what makes a held beat hold: past the end of
// its window the value stops moving instead of continuing past its target.

// --- palette -----------------------------------------------------------------------------------
//
// Warm and editorial rather than neutral-and-modern: a paper ground, coffee-brown ink, and a single
// terracotta accent borrowed from crust colour. Five values, because a sixth would have to earn a
// meaning and none of them can here.
export const WARM_PALETTE = {
  ground: "#F6EFE4",
  ink: "#2E2117",
  muted: "#8A7250",
  accent: "#B4551F",
  frame: "#EADBC4",
} as const;

// The vertical safe frame. Generous on purpose -- roughly a tenth of the width on each side, and
// more than that top and bottom, because a 9:16 frame is read on a phone with platform chrome over
// both ends and because the whitespace is the composition rather than a margin around it.
export const VERTICAL_SAFE_FRAME = {
  horizontal: 108,
  top: 176,
  bottom: 156,
} as const;

// --- the canvas ----------------------------------------------------------------------------------

// The ground every composition sits on: the warm paper, the safe frame, and a single very slow warm
// wash that keeps the background from reading as flat fill. The wash is a static radial gradient, not
// an animation -- it moves nothing and costs no determinism.
export function VerticalCanvas({ children, style }: { readonly children: ReactNode; readonly style?: CSSProperties }) {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: WARM_PALETTE.ground,
        backgroundImage: `radial-gradient(120% 70% at 50% 22%, #FDF8F0 0%, ${WARM_PALETTE.ground} 62%, #EFE4D3 100%)`,
        fontFamily: REMOTION_FONT_STACK,
        color: WARM_PALETTE.ink,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingLeft: VERTICAL_SAFE_FRAME.horizontal,
        paddingRight: VERTICAL_SAFE_FRAME.horizontal,
        paddingTop: VERTICAL_SAFE_FRAME.top,
        paddingBottom: VERTICAL_SAFE_FRAME.bottom,
        ...style,
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

// --- arrival ---------------------------------------------------------------------------------------

// FADE AND SUBTLE TRANSLATE, in one primitive rather than two.
//
// They are separable in principle and never separate in practice: everything in this composition
// arrives by fading up while rising a little, and a bare fade with no movement reads as a slideshow
// while a bare translate reads as a slide-in. Splitting them would produce two components that are
// always used together and a call site that has to remember to use both.
//
// The default rise is 24px against a 1920px frame -- about one and a quarter percent of the height.
// That is the "restrained" in restrained movement, stated as a number.
export function Reveal({
  window,
  children,
  riseFrom = 24,
  style,
}: {
  readonly window: TimingWindow;
  readonly children: ReactNode;
  readonly riseFrom?: number;
  readonly style?: CSSProperties;
}) {
  const frame = useCurrentFrame();
  const end = windowEnd(window);

  return (
    <div
      style={{
        opacity: interpolate(frame, [window.from, end], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
        // "0px <y>px" -- the rise is VERTICAL. Written as the standalone `translate` CSS property
        // rather than inside a `transform` string, per the official Remotion markup guidance, so it
        // stays a value a reader can see rather than an interpolated template.
        translate: `0px ${interpolate(frame, [window.from, end], [riseFrom, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }).toFixed(3)}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// --- the media frame --------------------------------------------------------------------------------

// A framed rectangle holding whatever the composition wants to show, plus the SAVORING ZOOM.
//
// The zoom runs across the WHOLE composition, not across the frame's own arrival window, and that is
// the entire creative point: the picture is never still, but it is never seen to move either. 1.00 to
// 1.06 over eight seconds is roughly 0.0075 of a percent per frame -- below the threshold at which a
// viewer reads it as an animation, and above the threshold at which the shot feels dead.
//
// `children` rather than a src prop. C1 renders a source-controlled SVG fixture here; C2 swaps in a
// real <CanvasImage> without this primitive changing, because a frame's job is to hold and crop
// something, not to know what that something is.
export function MediaFrame({
  window,
  totalDurationInFrames,
  children,
  zoomFrom = 1,
  zoomTo = 1.06,
  style,
}: {
  readonly window: TimingWindow;
  readonly totalDurationInFrames: number;
  readonly children: ReactNode;
  readonly zoomFrom?: number;
  readonly zoomTo?: number;
  readonly style?: CSSProperties;
}) {
  const frame = useCurrentFrame();

  return (
    <Reveal window={window} riseFrom={32} style={{ width: "100%", ...style }}>
      <div
        style={{
          width: "100%",
          aspectRatio: "4 / 5",
          overflow: "hidden",
          borderRadius: 10,
          backgroundColor: WARM_PALETTE.frame,
          // A hairline rather than a shadow. A drop shadow on a paper ground reads as a UI card;
          // a thin warm rule reads as a printed plate, which is the register this composition is in.
          boxShadow: `inset 0 0 0 2px rgba(46, 33, 23, 0.10)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            scale: interpolate(frame, [0, totalDurationInFrames], [zoomFrom, zoomTo], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              // Ease-out, not linear: the movement is very slightly faster at the start and settles,
              // which is what makes it read as savoring rather than as a mechanical push-in.
              easing: Easing.bezier(0.32, 0.94, 0.6, 1),
              output: "perceptual-scale",
            }),
          }}
        >
          {children}
        </div>
      </div>
    </Reveal>
  );
}

// --- typography ---------------------------------------------------------------------------------------

// Four roles, no free-form size prop.
//
// A `size` prop would let any call site invent a fifth typographic voice, and a composition with five
// voices is a composition with none. These four are the ones the first composition speaks in, and the
// numbers are the decisions -- editorial rather than interface-like: a headline large enough to carry
// the frame on its own, a kicker set in wide small caps, and generous line height on the supporting
// line so it reads as prose rather than as a caption.
//
// PURELY VISUAL. TypeBlock animates nothing; motion is Reveal's job, and keeping the two apart is
// what lets a beat's timing be changed without touching its typography.
export type TypeRole = "kicker" | "headline" | "support" | "mark";

const TYPE_ROLES: Record<TypeRole, CSSProperties> = {
  kicker: {
    fontSize: 30,
    fontWeight: 400,
    letterSpacing: "0.34em",
    textTransform: "uppercase",
    color: WARM_PALETTE.muted,
    lineHeight: 1,
  },
  headline: {
    fontSize: 92,
    fontWeight: 700,
    letterSpacing: "-0.022em",
    lineHeight: 1.04,
    color: WARM_PALETTE.ink,
  },
  support: {
    fontSize: 38,
    fontWeight: 400,
    letterSpacing: "-0.004em",
    lineHeight: 1.42,
    color: WARM_PALETTE.muted,
  },
  mark: {
    fontSize: 27,
    fontWeight: 700,
    letterSpacing: "0.3em",
    textTransform: "uppercase",
    color: WARM_PALETTE.ink,
    lineHeight: 1,
  },
};

export function TypeBlock({ role, children, style }: { readonly role: TypeRole; readonly children: ReactNode; readonly style?: CSSProperties }) {
  return <div style={{ ...TYPE_ROLES[role], ...style }}>{children}</div>;
}
