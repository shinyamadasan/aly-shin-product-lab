import { validateCreativePackageContentV2, type CreativePackageContentV2 } from "./creative-package-content-v2.ts";
import type { CreativeFormat, CreativePlatform } from "./creative-formats.ts";
import type { CreativeFraming, CreativeMovement } from "./creative-production-guidance.ts";

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
  // S6 -- the whole-video length, shown once beside the format in the opening summary. Null for
  // every format except Reel, which is the only one v2 stores a total for. The number is the
  // package's own derived targetDurationSeconds: this module does no timing arithmetic of its own,
  // and in particular never adds up shots itself.
  durationLabel: string | null;
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

// S6 -- the enums the package stores are machine vocabulary; these are what a person reads. Fixed
// maps, resolved by key: no AI call, no rewriting, and no prose parsing, exactly like FORMAT_LABELS
// above. An owner should never see "close_up" and never see a rephrasing that drifts between runs.
const FRAMING_LABELS: Record<CreativeFraming, string> = {
  close_up: "Close-up",
  medium: "Medium",
  wide: "Wide",
  overhead: "Overhead",
};

// There is no entry for null, and that is the point: null renders NOTHING. "Static" would be a
// direction the generator never gave, and printing it on most shots would bury the few that do move.
const MOVEMENT_LABELS: Record<CreativeMovement, string> = {
  push_in: "Slow push-in",
  pull_back: "Slow pull-back",
  pan: "Pan",
};

function present(value: string | null): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// The block title is assembled from structured fields only -- an index the view owns, fixed labels,
// and enum lookups. Absent guidance contributes no part, which is how a pre-S6 package renders as a
// plain "Shot 1" rather than "Shot 1 · · ".
function joinTitleParts(parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null).join(" · ");
}

function framingLabel(framing: CreativeFraming | undefined): string | null {
  return framing === undefined ? null : FRAMING_LABELS[framing];
}

// Three states, not two. undefined is a pre-S6 frame that never chose, and claiming either medium
// for it would be inventing the decision; null is an explicit still; a number is an explicit video.
function storyMediumParts(approxSeconds: number | null | undefined): string[] {
  if (approxSeconds === undefined) return [];
  if (approxSeconds === null) return ["Photo"];
  return ["Video", `about ${approxSeconds} seconds`];
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

    // Framing sits in the block title rather than becoming another line, so it reads as a property
    // of the shot the way "Shot 1 · Close-up" does, and so a pre-S6 photo package produces a null
    // title and no empty row at all.
    return [{ title: "Take this photo", blocks: [{ title: framingLabel(content.framing), lines }] }];
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
          // S6 -- how long, how close and whether the camera moves, all in the shot's own title, so
          // the owner reads the setup before the action instead of hunting for it. Every part is an
          // enum lookup or a number the package stores; nothing here is parsed out of direction.
          // A null movement contributes no part, so no shot ever displays "Static".
          return {
            title: joinTitleParts([
              `Shot ${index + 1}`,
              shot.approxSeconds === undefined ? null : `${shot.approxSeconds} sec`,
              framingLabel(shot.framing),
              shot.movement === undefined || shot.movement === null ? null : MOVEMENT_LABELS[shot.movement],
            ]),
            lines,
          };
        }),
      },
    ];

    // spokenScript and audioDirection are top-level siblings of shots in v2, not per-shot fields, so
    // they cannot be attached to any single shot and stay a separate, whole-video group. The total
    // length is no longer a line here: S6 shows it once, in the summary at the top of the screen,
    // beside the format, rather than as a footnote under the last shot.
    const lines: CreativePackageViewLine[] = [];
    const script = present(content.spokenScript);
    if (script) {
      lines.push({ label: "Say this", value: script });
    }
    lines.push({ label: "Sound", value: content.audioDirection });
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
        // "Photo" is stated on every slide, for every package including pre-S6 ones, because it is
        // an S6 FORMAT rule rather than package data: a Carousel slide is a still image. Deriving it
        // from a stored field would make a rule the contract already guarantees look optional.
        blocks: content.slides.map((slide, index) => ({
          title: joinTitleParts([`Slide ${index + 1}`, "Photo", framingLabel(slide.framing)]),
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
      // Unlike a Carousel slide, a Story frame's medium is a real decision the generator made, and
      // approxSeconds carries it: null means photo, a number means video of about that length.
      // ABSENT means a pre-S6 package that never made the decision, so nothing is claimed at all --
      // which is why this reads the property three ways rather than two.
      blocks: content.frames.map((frame, index) => ({
        title: joinTitleParts([
          `Frame ${index + 1}`,
          ...storyMediumParts(frame.approxSeconds),
          framingLabel(frame.framing),
        ]),
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
      durationLabel: validated.format === "reel" ? `About ${validated.targetDurationSeconds} seconds` : null,
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
  // The total moved out of the production section and into the summary, so it has to be carried
  // here explicitly or "copy everything" would silently stop telling the owner how long the Reel is.
  const lines: string[] = [view.durationLabel === null ? view.formatLabel : `${view.formatLabel} · ${view.durationLabel}`];

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
