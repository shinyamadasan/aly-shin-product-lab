import { sha256Hex } from "./asset-digest.ts";
import {
  GENERATED_ASSET_ALLOWED_MIME_TYPES,
  GENERATED_ASSET_MAX_FILE_SIZE_BYTES,
  type GeneratedAssetFileCandidate,
} from "./asset-generation-validation.ts";

export const GENERATED_ASSETS_BUCKET = "generated-assets";

export type SupportedGeneratedAssetMimeType = (typeof GENERATED_ASSET_ALLOWED_MIME_TYPES)[number];

export type InspectedAssetCandidate = {
  candidate: GeneratedAssetFileCandidate;
  actualMimeType: SupportedGeneratedAssetMimeType;
  actualWidth: number;
  actualHeight: number;
  extension: "png" | "jpg" | "webp";
  byteSize: number;
  sha256: string;
  bytes: Uint8Array;
};

export type AssetBinaryInspection =
  | { ok: true; facts: Omit<InspectedAssetCandidate, "candidate"> }
  | { ok: false; reason: "invalid-binary" | "unsupported-mime"; message: string };

export type AssetByteValidation =
  | { ok: true; inspected: InspectedAssetCandidate }
  | {
      ok: false;
      reason:
        | "invalid-binary"
        | "unsupported-mime"
        | "empty-bytes"
        | "file-too-large"
        | "mime-mismatch"
        | "dimension-mismatch"
        | "file-size-mismatch";
      message: string;
    };

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 24) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) + (bytes[offset + 1] ?? 0);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function decodePng(bytes: Uint8Array): Omit<InspectedAssetCandidate, "candidate" | "byteSize" | "sha256" | "bytes"> | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value) || ascii(bytes, 12, 4) !== "IHDR") {
    return null;
  }
  return { actualMimeType: "image/png", actualWidth: readUint32BigEndian(bytes, 16), actualHeight: readUint32BigEndian(bytes, 20), extension: "png" };
}

function decodeJpeg(bytes: Uint8Array): Omit<InspectedAssetCandidate, "candidate" | "byteSize" | "sha256" | "bytes"> | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const segmentLength = readUint16BigEndian(bytes, offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) {
      return null;
    }
    const isStartOfFrame = marker !== undefined && ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf));
    if (isStartOfFrame) {
      return {
        actualMimeType: "image/jpeg",
        actualHeight: readUint16BigEndian(bytes, offset + 5),
        actualWidth: readUint16BigEndian(bytes, offset + 7),
        extension: "jpg",
      };
    }
    offset += 2 + segmentLength;
  }

  return null;
}

function decodeWebp(bytes: Uint8Array): Omit<InspectedAssetCandidate, "candidate" | "byteSize" | "sha256" | "bytes"> | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return null;
  }

  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    const actualWidth = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
    const actualHeight = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
    return { actualMimeType: "image/webp", actualWidth, actualHeight, extension: "webp" };
  }

  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      actualMimeType: "image/webp",
      actualWidth: readUint16BigEndian(new Uint8Array([bytes[27] ?? 0, bytes[26] ?? 0]), 0) & 0x3fff,
      actualHeight: readUint16BigEndian(new Uint8Array([bytes[29] ?? 0, bytes[28] ?? 0]), 0) & 0x3fff,
      extension: "webp",
    };
  }

  return null;
}

function decodeGif(bytes: Uint8Array): boolean {
  return bytes.length >= 10 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a");
}

export async function inspectAssetBytes(bytes: Uint8Array): Promise<AssetBinaryInspection> {
  const decoded = decodePng(bytes) ?? decodeJpeg(bytes) ?? decodeWebp(bytes);
  if (!decoded) {
    return decodeGif(bytes)
      ? { ok: false, reason: "unsupported-mime", message: "Generated asset bytes decode as image/gif, which is not supported." }
      : { ok: false, reason: "invalid-binary", message: "Generated asset bytes are not a decodable PNG, JPEG, or WebP image." };
  }
  if (decoded.actualWidth <= 0 || decoded.actualHeight <= 0) {
    return { ok: false, reason: "invalid-binary", message: "Generated asset bytes have invalid decoded dimensions." };
  }

  return {
    ok: true,
    facts: {
      ...decoded,
      byteSize: bytes.length,
      sha256: await sha256Hex(bytes),
      bytes,
    },
  };
}

export async function validateAssetCandidateBytes(candidate: GeneratedAssetFileCandidate): Promise<AssetByteValidation> {
  if (candidate.bytes.length === 0) {
    return { ok: false, reason: "empty-bytes", message: "Generated asset bytes must not be empty." };
  }
  if (candidate.bytes.length > GENERATED_ASSET_MAX_FILE_SIZE_BYTES) {
    return { ok: false, reason: "file-too-large", message: `Generated asset bytes exceed ${GENERATED_ASSET_MAX_FILE_SIZE_BYTES} bytes.` };
  }

  const inspection = await inspectAssetBytes(candidate.bytes);
  if (!inspection.ok) {
    return inspection;
  }

  if (candidate.mimeType !== inspection.facts.actualMimeType) {
    return { ok: false, reason: "mime-mismatch", message: `Generated asset declared MIME ${candidate.mimeType} does not match decoded MIME ${inspection.facts.actualMimeType}.` };
  }
  if (candidate.width !== inspection.facts.actualWidth || candidate.height !== inspection.facts.actualHeight) {
    return { ok: false, reason: "dimension-mismatch", message: `Generated asset declared dimensions ${candidate.width}x${candidate.height} do not match decoded dimensions ${inspection.facts.actualWidth}x${inspection.facts.actualHeight}.` };
  }
  if (candidate.fileSizeBytes !== inspection.facts.byteSize) {
    return { ok: false, reason: "file-size-mismatch", message: `Generated asset declared fileSizeBytes ${candidate.fileSizeBytes} does not match actual byte size ${inspection.facts.byteSize}.` };
  }

  return { ok: true, inspected: { candidate, ...inspection.facts } };
}

export function buildGeneratedAssetObjectPath(args: { assetJobId: string; attemptNumber: number; sha256: string; extension: string }): string {
  return `asset-jobs/${args.assetJobId}/attempt-${args.attemptNumber}/${args.sha256}.${args.extension}`;
}
