// Portable SHA-256 for code that must run in both Node (CLI workers) and the browser (upload
// intake). node:crypto cannot run in a browser -- this is the one and only hash implementation
// asset-binary.ts uses, so nothing else needs to know which runtime it's on.
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Uint8Array's buffer type-widens to ArrayBufferLike, which SubtleCrypto's BufferSource
  // (ArrayBufferView<ArrayBuffer>) doesn't structurally accept -- a TS DOM-lib typing gap, not a
  // runtime one; Web Crypto accepts any Uint8Array regardless of its backing buffer type.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
