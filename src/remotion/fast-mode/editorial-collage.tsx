import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence, interpolate, useCurrentFrame } from "remotion";

import {
  NOT_FOR_PUBLISHING_LABEL,
  planEditorialCollageReel,
  resolvedMediaFor,
  type PreparedCampaign,
  type ReelScenePlan,
} from "../../lib/content-studio/creative-plan.ts";
import { CAROUSEL_LAYOUT, CTA_BORDER_WIDTH, END_RULE, REEL_LAYOUT } from "../../lib/content-studio/layout.ts";
import { REMOTION_FONT_STACK } from "../fonts.ts";
import { SCENE_PHOTO_LAYERS, arrive, photoLayerStyle, progress } from "./scene-motion.ts";

// Content Studio Fast Mode -- MOTION REEL: EDITORIAL_COLLAGE.
//
// Same spec, same words (creative-plan.ts), same tokens (spec.brand), same fitted type sizes and the
// same embedded faces (../fonts.ts loads src/lib/production-fonts.ts) as the carousel.
//
// REAL FOOTAGE FIRST. When the owner picks a video for a part of the Reel, that part plays the clip
// itself, muted, from its first frame, with no zoom or drift added: real motion is never dressed up,
// and a still photo is never made to pretend it is footage beyond a slow, plain scale.
//
// Motion is held to fade-and-rise arrivals, a slow scale or drift on stills, and hard cuts between
// four scenes. Layer timing lives in scene-motion.ts; every cut lands on a visible picture.
// No particles, burns, shake, kinetic type, generated imagery or sound design.

export type EditorialCollageProps = PreparedCampaign;

// A still or the owner's clip, filling its box. `stillTransform` applies to photos only.
function Picture({ campaign, id, width, height, radius = 0, stillTransform }: { campaign: PreparedCampaign; id: string; width: number; height: number; radius?: number; stillTransform?: string }) {
  const media = resolvedMediaFor(campaign.media, id);
  const fill: CSSProperties = { width, height, objectFit: "cover" };
  return (
    <div style={{ width, height, borderRadius: radius, overflow: "hidden", display: "flex" }}>
      {media.kind === "video" ? (
        <OffthreadVideo muted src={media.src} style={fill} />
      ) : (
        <Img src={media.dataUri} style={{ ...fill, transform: stillTransform }} />
      )}
    </div>
  );
}

function HeroScene({ scene, campaign }: { scene: Extract<ReelScenePlan, { kind: "hero" }>; campaign: PreparedCampaign }) {
  const frame = useCurrentFrame();
  const { color, typography: t, spacing } = campaign.spec.brand;
  const { width, height } = campaign.spec.output.reel;
  const scale = interpolate(frame, [0, scene.durationInFrames], [1, 1.06], { extrapolateRight: "clamp" });
  const size = campaign.copy.headline;

  return (
    <AbsoluteFill style={{ flexDirection: "column" }}>
      <div style={photoLayerStyle(SCENE_PHOTO_LAYERS.hero.photo, frame)}>
        <Picture campaign={campaign} height={height - REEL_LAYOUT.heroBandHeight} id={scene.mediaId} stillTransform={`scale(${scale})`} width={width} />
      </div>
      <div style={{ flexGrow: 1, display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: `${spacing.lg}px ${spacing.lg}px 0` }}>
        <div style={{ fontSize: size, fontWeight: t.weight.bold, lineHeight: t.lineHeight.tight, letterSpacing: size * t.letterSpacing.tight, maxWidth: width - spacing.lg * 2 - CAROUSEL_LAYOUT.heroWordmarkSlot - spacing.sm, ...arrive(frame, 8) }}>
          {scene.headline}
        </div>
        <div style={{ fontSize: t.body.md, fontWeight: t.weight.bold, color: color.muted, marginTop: spacing.sm, ...arrive(frame, 14) }}>{scene.wordmark}</div>
      </div>
    </AbsoluteFill>
  );
}

function CollageScene({ scene, campaign }: { scene: Extract<ReelScenePlan, { kind: "collage" }>; campaign: PreparedCampaign }) {
  const frame = useCurrentFrame();
  const { spacing, radius } = campaign.spec.brand;
  const { width } = campaign.spec.output.reel;
  const drift = interpolate(frame, [0, scene.durationInFrames], [0, 1], { extrapolateRight: "clamp" });
  const { detail, context } = REEL_LAYOUT.collage;

  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: spacing.lg, top: detail.top, ...photoLayerStyle(SCENE_PHOTO_LAYERS.collage.detail, frame) }}>
        <Picture campaign={campaign} height={detail.height} id={scene.detailMediaId} radius={radius.md} stillTransform={`scale(1.08) translateY(${12 - drift * 24}px)`} width={detail.width} />
      </div>
      <div style={{ position: "absolute", left: width - spacing.lg - context.width, top: context.top, ...photoLayerStyle(SCENE_PHOTO_LAYERS.collage.context, frame) }}>
        <Picture campaign={campaign} height={context.height} id={scene.contextMediaId} radius={radius.md} stillTransform={`scale(1.08) translateY(${drift * 16 - 8}px)`} width={context.width} />
      </div>
    </AbsoluteFill>
  );
}

function OfferScene({ scene, campaign }: { scene: Extract<ReelScenePlan, { kind: "offer" }>; campaign: PreparedCampaign }) {
  const frame = useCurrentFrame();
  const { copy } = campaign;
  const { color, typography: t, spacing, radius } = campaign.spec.brand;
  const { width } = campaign.spec.output.reel;
  const scale = interpolate(frame, [0, scene.durationInFrames], [1, 1.04], { extrapolateRight: "clamp" });
  const inner = width - spacing.lg * 2;

  return (
    <AbsoluteFill style={{ flexDirection: "column", padding: `${REEL_LAYOUT.offerTop}px ${spacing.lg}px 0` }}>
      <div style={photoLayerStyle(SCENE_PHOTO_LAYERS.offer.photo, frame)}>
        <Picture campaign={campaign} height={REEL_LAYOUT.offerPhotoHeight} id={scene.mediaId} radius={radius.md} stillTransform={`scale(${scale})`} width={inner} />
      </div>
      <div style={{ marginTop: spacing.md, maxWidth: inner, fontSize: copy.offerProductName, fontWeight: t.weight.bold, lineHeight: t.lineHeight.tight, letterSpacing: copy.offerProductName * t.letterSpacing.tight, ...arrive(frame, 8) }}>
        {scene.productName}
      </div>
      <div
        style={{
          marginTop: spacing.xs,
          maxWidth: inner,
          fontSize: copy.offerLine,
          fontWeight: t.weight.bold,
          lineHeight: t.lineHeight.tight,
          letterSpacing: copy.offerLine * t.letterSpacing.tight,
          color: color.accent,
          ...arrive(frame, 14),
        }}
      >
        {scene.offerLine}
      </div>
    </AbsoluteFill>
  );
}

function EndCardScene({ scene, campaign }: { scene: Extract<ReelScenePlan, { kind: "end_card" }>; campaign: PreparedCampaign }) {
  const frame = useCurrentFrame();
  const { copy } = campaign;
  const { color, typography: t, spacing, radius } = campaign.spec.brand;
  const { width } = campaign.spec.output.reel;
  const scale = interpolate(frame, [0, scene.durationInFrames], [1, 1.04], { extrapolateRight: "clamp" });
  const inner = width - spacing.lg * 2;

  return (
    <AbsoluteFill style={{ flexDirection: "column" }}>
      <div style={photoLayerStyle(SCENE_PHOTO_LAYERS.end_card.photo, frame)}>
        <Picture campaign={campaign} height={REEL_LAYOUT.endCardPhotoHeight} id={scene.mediaId} stillTransform={`scale(${scale})`} width={width} />
      </div>
      <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: spacing.lg, textAlign: "center" }}>
        <div style={{ fontSize: t.heading.xl, fontWeight: t.weight.bold, lineHeight: t.lineHeight.tight, letterSpacing: t.heading.xl * t.letterSpacing.tight, ...arrive(frame, 0) }}>
          {scene.wordmark}
        </div>
        <div style={{ height: END_RULE.height, marginTop: spacing.md, marginBottom: spacing.md, backgroundColor: color.accent, width: END_RULE.width * progress(frame, 6, 14) }} />
        <div style={{ maxWidth: inner, fontSize: copy.endProductName, lineHeight: t.lineHeight.normal, color: color.muted, ...arrive(frame, 10) }}>{scene.productName}</div>
        <div style={{ marginTop: spacing.xs, maxWidth: inner, fontSize: copy.endOfferLine, fontWeight: t.weight.bold, lineHeight: t.lineHeight.tight, letterSpacing: copy.endOfferLine * t.letterSpacing.tight, ...arrive(frame, 14) }}>
          {scene.offerLine}
        </div>
        <div
          style={{
            marginTop: spacing.lg,
            maxWidth: inner,
            padding: `${spacing.sm}px ${spacing.md}px`,
            border: `${CTA_BORDER_WIDTH}px solid ${color.accent}`,
            borderRadius: radius.lg,
            color: color.accent,
            fontSize: copy.cta,
            fontWeight: t.weight.bold,
            lineHeight: t.lineHeight.normal,
            ...arrive(frame, 20),
          }}
        >
          {scene.cta}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function NotForPublishingTag({ campaign }: { campaign: PreparedCampaign }) {
  const { color, typography: t, spacing, radius } = campaign.spec.brand;
  return (
    <div
      style={{
        position: "absolute",
        top: spacing.sm,
        right: spacing.sm,
        padding: `${spacing.xs / 2}px ${spacing.xs}px`,
        borderRadius: radius.sm,
        backgroundColor: color.foreground,
        color: color.background,
        fontSize: t.body.sm,
        fontWeight: t.weight.bold,
        letterSpacing: t.body.sm * t.letterSpacing.label,
      }}
    >
      {NOT_FOR_PUBLISHING_LABEL}
    </div>
  );
}

function renderScene(scene: ReelScenePlan, campaign: PreparedCampaign): ReactNode {
  switch (scene.kind) {
    case "hero":
      return <HeroScene campaign={campaign} scene={scene} />;
    case "collage":
      return <CollageScene campaign={campaign} scene={scene} />;
    case "offer":
      return <OfferScene campaign={campaign} scene={scene} />;
    case "end_card":
      return <EndCardScene campaign={campaign} scene={scene} />;
  }
}

export function EditorialCollage(campaign: EditorialCollageProps) {
  const { spec } = campaign;
  const plan = planEditorialCollageReel(spec);
  return (
    <AbsoluteFill style={{ backgroundColor: spec.brand.color.background, color: spec.brand.color.foreground, fontFamily: REMOTION_FONT_STACK }}>
      {plan.scenes.map((scene) => (
        <Sequence durationInFrames={scene.durationInFrames} from={scene.from} key={scene.kind}>
          {renderScene(scene, campaign)}
        </Sequence>
      ))}
      {campaign.notForPublishing ? <NotForPublishingTag campaign={campaign} /> : null}
    </AbsoluteFill>
  );
}
