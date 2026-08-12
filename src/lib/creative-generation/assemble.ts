import type { CreativeInput } from "../creative-input.ts";
import type { CreativeFormat } from "../creative-formats.ts";
import type { ResolvedCreativeGrounding } from "../creative-subject-resolution.ts";
import type { CreativeJobWorkerType } from "../creative-jobs.ts";
import { validateCreativePackageContentV2, type CreativePackageContentV2 } from "../creative-packages.ts";
import { validateCreativeBody, type CreativeFormatDecision } from "./contracts.ts";

// Content Creation MVP S3B -- deterministic assembly.
//
// The division this file enforces: the model authors the creative body, and the APPLICATION owns
// every factual and system-controlled field. Nothing a model returns can reach schemaVersion,
// subject, subjectSource, subjectGrounding, or any provenance field, because those are written
// here from inputs the model never sees the inside of.
//
// Pure: no clock, no I/O, no randomness. Same inputs, same package.

export type AssembleCreativePackageInput = {
  creativeInput: CreativeInput;
  grounding: ResolvedCreativeGrounding;
  decision: CreativeFormatDecision;
  // "user" when the human supplied a formatHint, "ai" when the generator chose. The caller decides,
  // because only the caller knows which stage produced the decision.
  formatChosenBy: "ai" | "user";
  // The raw, still-unvalidated model output. Validated here rather than trusted.
  body: unknown;
  sourceCreativeJobId: string;
  sourceWorker: CreativeJobWorkerType;
};

export type AssembleCreativePackageResult =
  | { ok: true; content: CreativePackageContentV2 }
  | { ok: false; reason: "format-mismatch" | "malformed-body" | "invalid-package"; message: string };

function bodyFieldsFor(format: CreativeFormat, body: Record<string, unknown>): Record<string, unknown> {
  if (format === "photo") {
    return { visualDirection: body.visualDirection, overlayText: body.overlayText };
  }
  if (format === "reel") {
    return {
      shots: body.shots,
      spokenScript: body.spokenScript,
      audioDirection: body.audioDirection,
      targetDurationSeconds: body.targetDurationSeconds,
    };
  }
  if (format === "carousel") {
    return { slides: body.slides };
  }
  return { frames: body.frames, interaction: body.interaction };
}

export function assembleCreativePackageV2(input: AssembleCreativePackageInput): AssembleCreativePackageResult {
  const { creativeInput, grounding, decision, formatChosenBy, body, sourceCreativeJobId, sourceWorker } = input;

  // A human-stated format is authoritative. If the caller pairs a hinted input with a decision for a
  // different format, that is a caller bug, and assembling anyway would quietly ignore what the
  // owner asked for -- the exact failure "formatHint being ignored" describes.
  if (creativeInput.formatHint !== null && creativeInput.formatHint !== decision.format) {
    return {
      ok: false,
      reason: "format-mismatch",
      message: `Creative input requested ${creativeInput.formatHint} but the decision chose ${decision.format}.`,
    };
  }

  // Strict, format-specific. This is what makes it impossible for a model to override factual
  // metadata: subject, subjectSource, metadata and schemaVersion are all unexpected fields here.
  const validatedBody = validateCreativeBody(decision.format, body);
  if (!validatedBody.ok) {
    return { ok: false, reason: "malformed-body", message: validatedBody.message };
  }
  const authored = validatedBody.body as unknown as Record<string, unknown>;

  const content = {
    schemaVersion: "v2",
    format: decision.format,

    // System-owned, from S3A. The model never supplies these.
    subject: grounding.subject,

    // Model-authored.
    angle: authored.angle,
    hook: authored.hook,
    headline: authored.headline,
    caption: authored.caption,
    cta: authored.cta,
    platformVariants: authored.platformVariants,
    ...bodyFieldsFor(decision.format, authored),

    metadata: {
      // Read from the job's own origin, never from anything the model returned.
      generatedFromOpportunity: creativeInput.origin.kind === "opportunity" ? creativeInput.origin.opportunityId : null,
      generatorVersion: "2",
      sourceCreativeJobId,
      sourceWorker,
      sourceJobResultSchemaVersion: "v2",
      formatChosenBy,
      formatRationale: decision.formatRationale,
      subjectSource: grounding.subjectSource,
      subjectGrounding: grounding.subjectGrounding,
    },
  };

  // S2 is the final authority on what a Creative Package is. S3B deliberately does not carry a
  // competing v2 validator -- the body validation above exists for better diagnostics, not to
  // replace this check.
  const validated = validateCreativePackageContentV2(content);
  if (!validated.ok) {
    return { ok: false, reason: "invalid-package", message: validated.message };
  }

  return { ok: true, content: validated.content };
}
