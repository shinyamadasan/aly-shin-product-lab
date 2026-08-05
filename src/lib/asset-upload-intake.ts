import { inspectAssetBytes } from "./asset-binary.ts";
import { GENERATED_ASSET_MAX_FILE_SIZE_BYTES, type GeneratedAssetFileCandidate } from "./asset-generation-validation.ts";

export type AssetUploadIntakeRejectionReason = "empty-bytes" | "file-too-large" | "invalid-binary" | "unsupported-mime";

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
export async function buildAssetUploadCandidate(bytes: Uint8Array): Promise<AssetUploadIntakeResult> {
  if (bytes.length === 0) {
    return { ok: false, reason: "empty-bytes", message: "The selected file is empty." };
  }
  if (bytes.length > GENERATED_ASSET_MAX_FILE_SIZE_BYTES) {
    return { ok: false, reason: "file-too-large", message: `The selected file exceeds the ${GENERATED_ASSET_MAX_FILE_SIZE_BYTES} byte limit.` };
  }

  const inspection = await inspectAssetBytes(bytes);
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
      durationMs: null,
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
