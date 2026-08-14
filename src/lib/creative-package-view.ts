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

// S5-R1 -- one labelled piece of an instruction. The label answers WHICH QUESTION this line is the
// answer to ("Show", "Text on slide", "Do", "Text on screen"), so the owner never has to work out
// whether a line is something to point the camera at or something to type.
//
// A null label means the line needs no question in front of it: a Photo's single direction, or the
// continuation of the line above it (a Carousel slide's body under "Text on slide").
export type CreativePackageViewLine = {
  label: string | null;
  value: string;
};

export type CreativePackageViewBlock = {
  // The unit being produced -- "Shot 1", "Slide 2", "Frame 3". Null when the section heading has
  // already said it and there is only one thing in the section.
  title: string | null;
  // Present lines only. An absent optional package field contributes no line at all, rather than an
  // empty row or the word "None".
  lines: CreativePackageViewLine[];
};

export type CreativePackageViewSection = {
  // Null for a group that continues the section above it under its own labels -- a Reel's
  // "Say this / Sound / Target length" are not shots, but they are not a new instruction either.
  title: string | null;
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
  // Both rendered, as the screen's opening summary: what am I making, and in what form. S4 computed
  // formatLabel but never showed it, so the owner was never told whether this was a Reel or a Photo.
  formatLabel: string;
  subject: string;
  // Format-specific production guidance -- the FIRST thing after the summary, because it is the
  // only part the owner has to act on with their hands. Never empty: every format has required
  // production fields, so every format contributes at least one section.
  production: CreativePackageViewSection[];
  // Only the variants the package actually carries. An empty list renders no platform UI at all;
  // no variant is ever fabricated for a platform the generator did not write one for.
  platformVariants: CreativePackageViewVariant[];
  // Pulled out by name because they are what the copy actions copy. `script` is null for every
  // format except a Reel that carries a spoken script.
  headline: string;
  caption: string;
  script: string | null;
  // Strategy, not execution: Subject / Angle / Hook / Headline / CTA, in that order. Secondary by
  // construction -- the owner should not have to read and interpret five pieces of marketing
  // vocabulary before they can find out what to photograph.
  //
  // Caption is deliberately NOT here. It is ready-to-post copy, so it belongs with the posting
  // section and the copy actions, not filed under strategy.
  creativeDetails: Array<{ label: string; value: string }>;
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

// Every section title below is an instruction in the imperative -- "Take this photo", not "How to
// shoot it" -- because the owner reading this is standing in a kitchen deciding what to do next,
// not evaluating a proposal.
//
// The v2 package supplies the structure; this function only names it. No prose is split, joined,
// summarised or reordered, and no step is invented that the package does not already carry.
function buildProduction(content: CreativePackageContentV2): CreativePackageViewSection[] {
  if (content.format === "photo") {
    // v2 gives Photo exactly ONE visualDirection string -- there is no ordered step structure the
    // way a Reel has shots[]. It is presented whole, unlabelled, rather than regex-split into
    // invented steps, which would fabricate an order the generator never wrote.
    const lines: CreativePackageViewLine[] = [{ label: null, value: content.visualDirection }];

    // "Add this text to the photo" rather than "Then add": overlayText is text that goes ON the
    // image, and an owner asked what "Then add" meant. The label states the action and the surface.
    const overlay = present(content.overlayText);
    if (overlay) {
      lines.push({ label: "Add this text to the photo", value: overlay });
    }

    return [{ title: "Take this photo", blocks: [{ title: null, lines }] }];
  }

  if (content.format === "reel") {
    const sections: CreativePackageViewSection[] = [
      {
        title: "Record these shots",
        blocks: content.shots.map((shot, index) => {
          // "Do" and "Text on screen" separate the action from the caption burned into the frame.
          // direction is passed through verbatim: whatever framing or movement it happens to carry
          // is the generator's words, and nothing is parsed out of it or added to it.
          const lines: CreativePackageViewLine[] = [{ label: "Do", value: shot.direction }];
          const onScreen = present(shot.onScreenText);
          if (onScreen) {
            lines.push({ label: "Text on screen", value: onScreen });
          }
          return { title: `Shot ${index + 1}`, lines };
        }),
      },
    ];

    // spokenScript, audioDirection and targetDurationSeconds are top-level siblings of shots in v2,
    // not per-shot fields, so they cannot be attached to any single shot. They stay a separate,
    // whole-video group -- which is also why the length below says "in total": v2 carries NO
    // per-shot timing, and splitting this number across the shots would invent it.
    const lines: CreativePackageViewLine[] = [];
    const script = present(content.spokenScript);
    if (script) {
      lines.push({ label: "Say this", value: script });
    }
    lines.push({ label: "Sound", value: content.audioDirection });
    lines.push({ label: "Target length", value: `About ${content.targetDurationSeconds} seconds in total` });
    sections.push({ title: null, blocks: [{ title: null, lines }] });

    return sections;
  }

  if (content.format === "carousel") {
    return [
      {
        title: "Build these slides",
        // "Show" before "Text on slide", because the owner asked whether the heading meant they had
        // to photograph it. visualDirection is the asset to make; heading and body are what gets
        // typed onto it. All three verbatim.
        blocks: content.slides.map((slide, index) => ({
          title: `Slide ${index + 1}`,
          lines: [
            { label: "Show", value: slide.visualDirection },
            { label: "Text on slide", value: slide.heading },
            { label: null, value: slide.body },
          ],
        })),
      },
    ];
  }

  const sections: CreativePackageViewSection[] = [
    {
      title: "Post these frames",
      blocks: content.frames.map((frame, index) => ({
        title: `Frame ${index + 1}`,
        lines: [
          { label: "Show", value: frame.visualDirection },
          { label: "Text", value: frame.text },
        ],
      })),
    },
  ];

  // A poll or question is a thing the owner adds to the story, not a frame to shoot, so it gets its
  // own group and its own verb rather than sitting in the frame list.
  const interaction = present(content.interaction);
  if (interaction) {
    sections.push({ title: null, blocks: [{ title: null, lines: [{ label: "Add interaction", value: interaction }] }] });
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
      // The package's own subject, verbatim. No second title is generated for the summary line --
      // inventing one would be new creative content, and this module writes none.
      subject: validated.subject,
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
      creativeDetails: [
        { label: "Subject", value: validated.subject },
        { label: "Angle", value: validated.angle },
        { label: "Hook", value: validated.hook },
        { label: "Headline", value: validated.headline },
        { label: "Call to action", value: validated.cta },
      ],
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

  for (const detail of view.creativeDetails) {
    lines.push("", `${detail.label}: ${detail.value}`);
  }

  // Carried explicitly because the caption is no longer filed under creativeDetails. Dropping it
  // here would make "copy everything" quietly lose the one line most likely to be pasted.
  lines.push("", `Caption: ${view.caption}`);

  for (const section of view.production) {
    lines.push("");
    if (section.title !== null) {
      lines.push(section.title);
    }
    for (const block of section.blocks) {
      if (block.title !== null) {
        lines.push(block.title);
      }
      for (const line of block.lines) {
        lines.push(line.label === null ? line.value : `${line.label}: ${line.value}`);
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
