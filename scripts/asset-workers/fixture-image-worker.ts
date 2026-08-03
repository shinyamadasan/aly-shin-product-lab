import type { AssetJobExecutor } from "../../src/lib/asset-jobs.ts";

function fixturePngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x08, 0x04, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

export const fixtureImageAssetExecutor: AssetJobExecutor = (_job, spec) => {
  const bytes = fixturePngBytes(spec.dimensions.width, spec.dimensions.height);
  return [
    {
      position: 0,
      mimeType: "image/png",
      width: spec.dimensions.width,
      height: spec.dimensions.height,
      durationMs: null,
      fileSizeBytes: bytes.length,
      bytes,
    },
  ];
};
