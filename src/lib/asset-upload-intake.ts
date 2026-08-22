import { inspectMediaBytes } from "./asset-binary.ts";
import { maxGeneratedAssetFileSizeBytes, type GeneratedAssetFileCandidate } from "./asset-generation-validation.ts";
import type { AssetKind } from "./asset-jobs.ts";

export type AssetUploadIntakeRejectionReason = "empty-bytes" | "file-too-large" | "invalid-binary" | "unsupported-mime" | "unsupported-video-codec";

export type AssetUploadIntakeResult =
  | { ok: true; candidate: GeneratedAssetFileCandidate }
  | { ok: false; reason: AssetUploadIntakeRejectionReason; message: string };

// The one canonical "bytes -> a validated upload candidate" boundary. Every upload mechanism --
// browser file picker, drag-and-drop, camera capture, clipboard paste, a future Telegram or share-
// target integration, or this repo's own desktop CLI -- funnels through this exact function. It
// knows nothing about where the bytes came from, on purpose: the source must never change what
// counts as a valid image or how it becomes a candidate. position/durationMs are fixed because this
// milestone supports exactly one image file per Asset Job (see asset-generation-validation.ts's
// wrong-file-count check); mimeType/width/height/fileSizeBytes are always the actual, decoded facts
// -- never a caller-declared or source-declared value (e.g. a browser File's own .type) -- so the
// later declared-vs-actual anti-tamper check in asset-binary.ts can never disagree with itself.
// Wave C2A -- assetKind, defaulting to "image".
//
// The default is what keeps every existing caller (the browser file picker, the manual-illustration
// composer, and the CLI import path) byte-identically unchanged: all three upload images, all three
// pass nothing, and all three still get the exact PNG/JPEG/WebP behaviour and the exact 10 MiB
// ceiling they have always had.
//
// What the parameter buys is that the kind now decides BOTH the decoder and the byte ceiling, in one
// place, so a video can never be admitted through the image ceiling and an image can never be
// admitted by the container parser.
export async function buildAssetUploadCandidate(bytes: Uint8Array, assetKind: AssetKind = "image"): Promise<AssetUploadIntakeResult> {
  if (bytes.length === 0) {
    return { ok: false, reason: "empty-bytes", message: "The selected file is empty." };
  }
  const maxFileSizeBytes = maxGeneratedAssetFileSizeBytes(assetKind);
  if (bytes.length > maxFileSizeBytes) {
    return { ok: false, reason: "file-too-large", message: `The selected file exceeds the ${maxFileSizeBytes} byte limit.` };
  }

  const inspection = await inspectMediaBytes(bytes, assetKind);
  if (!inspection.ok) {
    return { ok: false, reason: inspection.reason, message: inspection.message };
  }

  return {
    ok: true,
    candidate: {
      position: 0,
      mimeType: inspection.facts.actualMimeType,
      width: inspection.facts.actualWidth,
      height: inspection.facts.actualHeight,
      // Read out of the container, never declared. Still null for every image -- inspectAssetBytes
      // returns null there by construction, so the image candidate shape is unchanged.
      durationMs: inspection.facts.actualDurationMs,
      fileSizeBytes: inspection.facts.byteSize,
      bytes,
    },
  };
}

// The one browser-shaped adapter -- everything above this line is source-agnostic and knows nothing
// about Blob/File. Takes Blob rather than File specifically: File extends Blob, so a real
// <input type="file"> selection still works, but this also directly accepts what drag-and-drop
// (DataTransferItem.getAsFile() still yields a File, but some drop payloads are Blob-shaped),
// camera capture (canvas.toBlob), and clipboard paste (ClipboardItem's blobs) actually hand back.
// Converts to bytes, then defers entirely to buildAssetUploadCandidate -- this function validates
// nothing itself.
export async function buildAssetUploadCandidateFromBlob(blob: Blob): Promise<AssetUploadIntakeResult> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return buildAssetUploadCandidate(bytes);
}
