import { validateCreativePackageContentV2, type CreativePackageContentV2 } from "./creative-package-content-v2.ts";
import type { CreativeFormat, CreativePlatform } from "./creative-formats.ts";

// Content Creation MVP S4 -- turns a validated Creative Package v2 into something a person can read
// and act on, without the component having to know the shape of four different formats.
//
// Pure: no clock, no I/O, no randomness, no AI. Given the same package it produces the same view,
// which is what lets the result experience be tested against typed fixtures instead of a live
// generation.
//
// Nothing here rewrites, summarises, shortens or improves generated content. Every string below is
// either a fixed label this module owns or a verbatim field from the package. The package says what
// to make; this module only decides the order it is read in.

export type CreativePackageViewBlock = {
  title: string;
  body: string;
  // A secondary line under the block -- "On screen: ...", "Visual: ..." -- present only when the
  // package actually carries that optional field. An absent optional field renders nothing at all
  // rather than an empty row or the word "None".
  note: string | null;
};

export type CreativePackageViewSection = {
  title: string;
  blocks: CreativePackageViewBlock[];
};

export type CreativePackageViewVariant = {
  platform: CreativePlatform;
  label: string;
  caption: string;
  hashtags: string[];
};

export type CreativePackageView = {
  format: CreativeFormat;
  formatLabel: string;
  // Subject / Angle / Hook / Headline / Caption / CTA, in that order. Always all six: the v2
  // validator requires every one of them to be a non-empty string, so none of them can be missing.
  essentials: Array<{ label: string; value: string }>;
  // Format-specific production guidance. Empty for no format -- every format contributes at least
  // one section, because every format has required production fields.
  production: CreativePackageViewSection[];
  // Only the variants the package actually carries. An empty list renders no platform UI at all;
  // no variant is ever fabricated for a platform the generator did not write one for.
  platformVariants: CreativePackageViewVariant[];
  // Pulled out by name because they are what the copy actions copy. `script` is null for every
  // format except a Reel that carries a spoken script.
  headline: string;
  caption: string;
  script: string | null;
};

export type CreativePackageViewResult = { ok: true; view: CreativePackageView } | { ok: false; message: string };

const FORMAT_LABELS: Record<CreativeFormat, string> = {
  photo: "Photo",
  reel: "Reel",
  carousel: "Carousel",
  story: "Story",
};

const PLATFORM_LABELS: Record<CreativePlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
};

function present(value: string | null): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function buildProduction(content: CreativePackageContentV2): CreativePackageViewSection[] {
  if (content.format === "photo") {
    const overlay = present(content.overlayText);
    return [
      {
        title: "How to shoot it",
        blocks: [{ title: "Visual direction", body: content.visualDirection, note: overlay ? `Text on the photo: ${overlay}` : null }],
      },
    ];
  }

  if (content.format === "reel") {
    const sections: CreativePackageViewSection[] = [
      {
        title: "Shots, in order",
        blocks: content.shots.map((shot, index) => {
          const onScreen = present(shot.onScreenText);
          return { title: `Shot ${index + 1}`, body: shot.direction, note: onScreen ? `On screen: ${onScreen}` : null };
        }),
      },
    ];

    const script = present(content.spokenScript);
    const soundBlocks: CreativePackageViewBlock[] = [];
    if (script) {
      soundBlocks.push({ title: "What to say", body: script, note: null });
    }
    soundBlocks.push({ title: "Sound", body: content.audioDirection, note: null });
    soundBlocks.push({ title: "Length", body: `About ${content.targetDurationSeconds} seconds`, note: null });
    sections.push({ title: "Sound and length", blocks: soundBlocks });

    return sections;
  }

  if (content.format === "carousel") {
    return [
      {
        title: "Slides, in order",
        blocks: content.slides.map((slide, index) => ({
          title: `Slide ${index + 1} — ${slide.heading}`,
          body: slide.body,
          note: `Visual: ${slide.visualDirection}`,
        })),
      },
    ];
  }

  const sections: CreativePackageViewSection[] = [
    {
      title: "Frames, in order",
      blocks: content.frames.map((frame, index) => ({
        title: `Frame ${index + 1}`,
        body: frame.text,
        note: `Visual: ${frame.visualDirection}`,
      })),
    },
  ];

  const interaction = present(content.interaction);
  if (interaction) {
    sections.push({ title: "Ask your followers", blocks: [{ title: "Interaction", body: interaction, note: null }] });
  }

  return sections;
}

// Runs the authoritative S2 validator rather than trusting the stored JSON. A Creative Package row
// is data from the database, and rendering unvalidated JSON as if it were a package is how a
// malformed row becomes a crashed screen.
export function buildCreativePackageView(content: unknown): CreativePackageViewResult {
  const validation = validateCreativePackageContentV2(content);
  if (!validation.ok) {
    return { ok: false, message: validation.message };
  }

  const validated = validation.content;

  return {
    ok: true,
    view: {
      format: validated.format,
      formatLabel: FORMAT_LABELS[validated.format],
      essentials: [
        { label: "Subject", value: validated.subject },
        { label: "Angle", value: validated.angle },
        { label: "Hook", value: validated.hook },
        { label: "Headline", value: validated.headline },
        { label: "Caption", value: validated.caption },
        { label: "Call to action", value: validated.cta },
      ],
      production: buildProduction(validated),
      platformVariants: validated.platformVariants.map((variant) => ({
        platform: variant.platform,
        label: PLATFORM_LABELS[variant.platform],
        caption: variant.caption,
        hashtags: variant.hashtags,
      })),
      headline: validated.headline,
      caption: validated.caption,
      script: validated.format === "reel" ? present(validated.spokenScript) : null,
    },
  };
}

export function formatHashtags(hashtags: string[]): string {
  return hashtags.join(" ");
}

// The "copy everything" payload. Plain text on purpose: it is pasted into a phone's notes app or a
// caption box, never re-parsed, so JSON would be a worse artifact than prose.
export function formatCreativePackageForClipboard(view: CreativePackageView): string {
  const lines: string[] = [view.formatLabel];

  for (const essential of view.essentials) {
    lines.push("", `${essential.label}: ${essential.value}`);
  }

  for (const section of view.production) {
    lines.push("", section.title);
    for (const block of section.blocks) {
      lines.push(`- ${block.title}: ${block.body}`);
      if (block.note !== null) {
        lines.push(`  ${block.note}`);
      }
    }
  }

  for (const variant of view.platformVariants) {
    lines.push("", variant.label, variant.caption);
    if (variant.hashtags.length > 0) {
      lines.push(formatHashtags(variant.hashtags));
    }
  }

  return lines.join("\n");
}
