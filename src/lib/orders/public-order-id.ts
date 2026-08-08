// S9 PR-F2: deterministic identifiers for a public submission.
//
// The browser never supplies an order id. It supplies an idempotency key, and the server DERIVES
// the ids from it, which buys two things at once:
//
//   1. IDEMPOTENCY. The same key always produces the same order id, so a double tap, a timeout
//      retry, or a resubmitted request converges on one row rather than creating several.
//
//   2. UNAIMABILITY. Because the derivation is a one-way hash, an attacker cannot craft a key that
//      lands on an existing order's id -- doing so would require a preimage. This matters because
//      save_order writes the whole order row; an attacker who could choose the id could otherwise
//      aim a submission at someone else's paid order.
//
// RFC 4122 version 5 (SHA-1, namespaced). Uses Web Crypto, which is a global in both Node 18+ and
// browsers, so this module pulls in no node builtin and cannot break a client bundle.

// Distinct namespaces mean the same idempotency key derives an order id and a customer id that are
// unrelated, rather than one being computable from the other.
const ORDER_NAMESPACE = "6f8b1a52-3c1e-4f9a-9a3d-2b7c5e4d1a90";
const CUSTOMER_NAMESPACE = "b2d47c9e-5a61-4c3f-8e17-9d0a6f2b4c38";

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function uuidV5(name: string, namespace: string): Promise<string> {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);

  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.slice(0, 16);
  // Version 5 in the high nibble of byte 6; RFC 4122 variant in the top bits of byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return bytesToUuid(bytes);
}

export function derivePublicOrderId(idempotencyKey: string): Promise<string> {
  return uuidV5(idempotencyKey, ORDER_NAMESPACE);
}

export function derivePublicCustomerId(idempotencyKey: string): Promise<string> {
  return uuidV5(idempotencyKey, CUSTOMER_NAMESPACE);
}
