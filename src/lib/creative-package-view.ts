import { validateCreativePackageContentV2, type CreativePackageContentV2 } from "./creative-package-content-v2.ts";
import type { CreativeFormat, CreativePlatform } from "./creative-formats.ts";
import { productionSourceRequiresFraming, type CreativeFraming, type CreativeMovement, type CreativeProductionSource } from "./creative-production-guidance.ts";

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
  //
  // P1 §5 -- production-aware for `photo` only, because `photo` is the only format whose LABEL went
  // wrong. H1-B widened the stored enum value to mean ONE STATIC VISUAL POST without widening the
  // word the owner reads, so a generated illustration was announced as "Photo" directly above a
  // "Make this visual" instruction. Reel, Carousel and Story never had that mismatch and are
  // untouched.
  formatLabel: string;
  // P1 §6 -- HOW this gets made, as the owner's words rather than the enum's. Null for a pre-H1-B
  // package, which never recorded the decision: a package that did not answer the question must not
  // be shown an answer, and "Photo capture" would be exactly the guess the absent value refuses to
  // make elsewhere in this codebase.
  productionLabel: string | null;
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

// P1 §5 -- what `photo` is called once the package has answered how it gets made.
//
// "Static post" rather than "Photo", because H1-B's widened meaning is exactly that: one still
// visual, whatever produced it. The word is the same for all three sources, since the FORMAT did not
// change between them -- only the production route did, and that is productionLabel's job below.
// Splitting the two apart is what stops the summary from saying "Illustrated visual" twice.
const PHOTO_FORMAT_LABEL = "Static post";

// P1 §6 -- the production route in owner vocabulary. Fixed strings resolved by key, exactly like
// FORMAT_LABELS and FRAMING_LABELS above: no enum value ever reaches the screen, and no wording
// drifts between two runs of the same package.
//
// The "No shooting required" half is the part the owner actually acts on. It is attached only to the
// two sources where it is news -- it answers "do I need to pick up my phone?" before they have read
// a single instruction, which is the question the zero-capture owner test was really about.
const PRODUCTION_LABELS: Record<CreativeProductionSource, string> = {
  capture_new: "Photo capture",
  generate_visual: "Illustrated visual · No shooting required",
  template_only: "Graphic · No shooting required",
};

// Reel is the one format where capture_new does not mean photography, so it is the one format that
// needs its own word. Everything else that captures is a still, and "Photo capture" is accurate for
// a Carousel of photographs and a Story of photographs alike.
const REEL_CAPTURE_LABEL = "Filmed on your phone";

function productionLabel(format: CreativeFormat, productionSource: CreativeProductionSource | undefined): string | null {
  if (productionSource === undefined) return null;
  if (format === "reel" && productionSource === "capture_new") return REEL_CAPTURE_LABEL;
  return PRODUCTION_LABELS[productionSource];
}

// Absent productionSource keeps the label the owner has always seen. Treating absence as capture_new
// would be a guess; keeping "Photo" is simply not answering a question the package never answered.
function formatLabel(format: CreativeFormat, productionSource: CreativeProductionSource | undefined): string {
  return format === "photo" && productionSource !== undefined ? PHOTO_FORMAT_LABEL : FORMAT_LABELS[format];
}

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
//
// H1-B adds a fourth consideration ahead of all three: when the package is not a fresh capture,
// "Photo" is simply the wrong word for a still frame -- the frame is an illustration or a graphic,
// and the format section already says what to do with it. The medium part is dropped rather than
// renamed, because a zero-capture Story frame can only be still, so the label would carry no
// information the reader does not already have.
function storyMediumParts(approxSeconds: number | null | undefined, capturing: boolean): string[] {
  if (!capturing) return [];
  if (approxSeconds === undefined) return [];
  if (approxSeconds === null) return ["Photo"];
  return ["Video", `about ${approxSeconds} seconds`];
}

// H1-B §21 -- the execution instruction changes with the production source, because "Take this
// photo" is an instruction to do something the owner has said they will not do. The distinction the
// owner needs is which KIND of making this is; the imperative voice is unchanged.
//
// Absent productionSource is a pre-H1-B package, and it keeps the exact heading it has always had.
// Treating absence as capture_new would be a guess, but "Take this photo" is what those packages
// have always said and what they were generated to mean.
const PHOTO_SECTION_TITLES: Record<CreativeProductionSource, string> = {
  capture_new: "Take this photo",
  generate_visual: "Make this visual",
  template_only: "Make this graphic",
};

// The one question the renderer asks about production source. Absent reads as capture, which is
// what every pre-H1-B package was: S6 packages carry framing and camera directions throughout.
function isCapturing(productionSource: CreativeProductionSource | undefined): boolean {
  return productionSource === undefined || productionSourceRequiresFraming(productionSource);
}

// Every section title below is an instruction in the imperative -- "Take this photo", not "How to
// shoot it" -- because the owner reading this is standing in a kitchen deciding what to do next,
// not evaluating a proposal.
//
// The v2 package supplies the structure; this function only names it. No prose is split, joined,
// summarised or reordered, and no step is invented that the package does not already carry.
function buildProduction(content: CreativePackageContentV2): CreativePackageViewSection[] {
  const capturing = isCapturing(content.productionSource);

  if (content.format === "photo") {
    // P1 §7 -- when the package carries a structured brief, the brief IS the instruction and the
    // flat visualDirection is only its compatibility form. Rendering both would show the owner the
    // same visual described twice, so the flat string is skipped entirely here rather than appended.
    //
    // Every line below is a whole brief field, labelled. Nothing is parsed, split, joined or
    // summarised -- the structure is the generator's own, which is exactly what the additive
    // contract bought and what a prose parser could never have given honestly.
    const lines: CreativePackageViewLine[] =
      content.visualBrief === undefined
        ? // No brief: a pre-P1 package, or a capture. Unchanged from S4 -- one whole unlabelled
          // string, never regex-split into invented steps.
          [{ label: null, value: content.visualDirection }]
        : [
            { label: "Concept", value: content.visualBrief.concept },
            { label: "Style", value: content.visualBrief.style },
            ...content.visualBrief.scene.map((item, index) => ({ label: index === 0 ? "Scene" : null, value: item })),
          ];

    // "Add this text to the photo" rather than "Then add": overlayText is text that goes ON the
    // image, and an owner asked what "Then add" meant. The label states the action and the surface.
    // H1-B widens the surface noun with the section: on a generated or template visual there is no
    // photo to add text to.
    const overlay = present(content.overlayText);
    if (overlay) {
      lines.push({ label: capturing ? "Add this text to the photo" : "Add this text to the visual", value: overlay });
    }

    // Last, and after the text, exactly as §7's hierarchy orders it: these are the constraints that
    // keep the visual buildable, and they are read once the owner knows what they are building.
    // The contract requires at least one, so there is no empty-section branch to carry here.
    if (content.visualBrief !== undefined) {
      lines.push(
        ...content.visualBrief.executionNotes.map((note, index) => ({ label: index === 0 ? "Execution notes" : null, value: note })),
      );
    }

    // Framing sits in the block title rather than becoming another line, so it reads as a property
    // of the shot the way "Shot 1 · Close-up" does, and so a pre-S6 photo package produces a null
    // title and no empty row at all. A zero-capture package carries no framing at all, so the same
    // mechanism gives it a null title for free.
    return [
      {
        title: content.productionSource === undefined ? PHOTO_SECTION_TITLES.capture_new : PHOTO_SECTION_TITLES[content.productionSource],
        blocks: [{ title: framingLabel(content.framing), lines }],
      },
    ];
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
        // "Photo" is stated on every CAPTURED slide, for every such package including pre-S6 and
        // pre-H1-B ones, because it is a FORMAT rule rather than package data: a Carousel slide is a
        // still image. H1-B keeps the rule and corrects the word -- S6 said every slide is a still
        // PHOTO, and it is now a still VISUAL, which may be an illustration or a typography card.
        // On those, "Photo" was never data the package carried and is now simply wrong, so nothing
        // is printed rather than a second invented label.
        blocks: content.slides.map((slide, index) => ({
          title: joinTitleParts([`Slide ${index + 1}`, capturing ? "Photo" : null, framingLabel(slide.framing)]),
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
          ...storyMediumParts(frame.approxSeconds, capturing),
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
      formatLabel: formatLabel(validated.format, validated.productionSource),
      productionLabel: productionLabel(validated.format, validated.productionSource),
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

  // Carried explicitly for the same reason the Reel total is: "copy everything" is the artifact the
  // owner pastes into their notes and works from later, so a production route that exists on screen
  // and not in the clipboard would quietly become the one instruction they lose.
  if (view.productionLabel !== null) {
    lines.push(view.productionLabel);
  }

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
