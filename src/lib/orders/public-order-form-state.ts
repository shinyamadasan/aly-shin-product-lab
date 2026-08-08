// S9 PR-F3: the customer-facing order form's logic, as pure functions.
//
// The rules worth getting right are not visual, so they live here rather than inside the component:
// which idempotency key a submission carries, what survives a rejection, and what the customer is
// told. All of it is testable without a DOM.
//
// THE IDEMPOTENCY LIFECYCLE IS THE POINT. F2 guarantees that one key produces at most one order,
// however many times it is submitted. That guarantee is only worth anything if this side keeps the
// key stable across exactly the situations where a customer would naturally try again:
//
//     double-click · network timeout · fetch failure · 503 · prices-changed · unavailable · invalid
//
// Minting a fresh key on failure would turn one customer's repeated attempts into several distinct
// orders -- defeating F2 entirely, and doing so silently. The key is retired only after a
// definitive success, because only then is the logical order actually finished.
//
// Pure: no fetch, no clock, no crypto. `newKey` is injected so a test can make it deterministic.

import { isOrderSource, type OrderSource } from "./types.ts";
import type { PublicMenuProduct } from "./public-menu.ts";
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH, MAX_PHONE_LENGTH, MAX_QUANTITY_PER_LINE, MAX_REQUESTED_TIME_LENGTH, MAX_SOURCE_REF_LENGTH } from "./public-submission.ts";

export type PublicOrderContact = {
  customerName: string;
  phone: string;
  requestedTime: string;
  notes: string;
};

export const EMPTY_CONTACT: PublicOrderContact = { customerName: "", phone: "", requestedTime: "", notes: "" };

// What the customer is currently being shown about their last attempt.
export type PublicOrderStatus =
  | { kind: "editing" }
  | { kind: "submitting" }
  // Terminal for this logical order: it exists, and must not be resubmitted.
  | { kind: "received" }
  | { kind: "prices-changed"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string };

export type PublicOrderFormState = {
  menu: PublicMenuProduct[];
  // sellingFormatId -> quantity. Absent or 0 means not ordered.
  quantities: Record<string, number>;
  contact: PublicOrderContact;
  // ONE key per logical order. See the header.
  idempotencyKey: string;
  status: PublicOrderStatus;
};

export function createInitialState(menu: PublicMenuProduct[], newKey: () => string): PublicOrderFormState {
  return { menu, quantities: {}, contact: { ...EMPTY_CONTACT }, idempotencyKey: newKey(), status: { kind: "editing" } };
}

// --- Selection ------------------------------------------------------------------------------------

export function setQuantity(state: PublicOrderFormState, sellingFormatId: string, quantity: number): PublicOrderFormState {
  const clamped = Number.isFinite(quantity) ? Math.max(0, Math.min(MAX_QUANTITY_PER_LINE, Math.floor(quantity))) : 0;
  const quantities = { ...state.quantities };
  if (clamped === 0) {
    delete quantities[sellingFormatId];
  } else {
    quantities[sellingFormatId] = clamped;
  }
  // Touching the order returns it to editing, so a stale rejection banner does not linger over a
  // selection the customer has since changed.
  return { ...state, quantities, status: state.status.kind === "submitting" ? state.status : { kind: "editing" } };
}

export function setContact(state: PublicOrderFormState, patch: Partial<PublicOrderContact>): PublicOrderFormState {
  return { ...state, contact: { ...state.contact, ...patch }, status: state.status.kind === "submitting" ? state.status : { kind: "editing" } };
}

export type SelectedLine = { product: PublicMenuProduct; format: PublicMenuProduct["formats"][number]; quantity: number };

// Only formats still present in the CURRENT menu are selected. After a refreshed menu arrives, a
// quantity for a format that no longer exists simply stops counting -- it is never submitted.
export function getSelectedLines(state: PublicOrderFormState): SelectedLine[] {
  const lines: SelectedLine[] = [];
  for (const product of state.menu) {
    for (const format of product.formats) {
      const quantity = state.quantities[format.sellingFormatId] ?? 0;
      if (quantity > 0) {
        lines.push({ product, format, quantity });
      }
    }
  }
  return lines;
}

export function getOrderTotal(state: PublicOrderFormState): number {
  return getSelectedLines(state).reduce((total, line) => total + line.format.unitPrice * line.quantity, 0);
}

// --- What may be submitted -------------------------------------------------------------------------

export function getSubmitBlocker(state: PublicOrderFormState): string | null {
  if (state.status.kind === "submitting") return "Sending your order…";
  if (state.status.kind === "received") return "This order has already been sent.";
  if (getSelectedLines(state).length === 0) return "Choose at least one item.";
  if (state.contact.customerName.trim() === "") return "Please add your name.";
  if (state.contact.phone.trim() === "") return "Please add a mobile number so we can confirm.";
  return null;
}

export function canSubmit(state: PublicOrderFormState): boolean {
  return getSubmitBlocker(state) === null;
}

// --- The request ------------------------------------------------------------------------------------
//
// Exactly the shape F2's parser reads, and nothing more. Notably absent: any price the server should
// decide, any id, any status, any entry method. `displayedUnitPrice` is the number the customer was
// actually shown, sent so the server can refuse if it has since changed -- never so it can be used.

export type PublicOrderRequestBody = {
  idempotencyKey: string;
  items: { productId: string; sellingFormatId: string; quantity: number; displayedUnitPrice: number }[];
  customerName: string;
  phone: string;
  requestedTime: string;
  notes: string;
  source: OrderSource;
  sourceRef: string;
  trap: string;
};

export function buildRequestBody(state: PublicOrderFormState, attribution: { source: OrderSource; sourceRef: string }, trap: string): PublicOrderRequestBody {
  return {
    idempotencyKey: state.idempotencyKey,
    items: getSelectedLines(state).map((line) => ({
      productId: line.product.productId,
      sellingFormatId: line.format.sellingFormatId,
      quantity: line.quantity,
      displayedUnitPrice: line.format.unitPrice,
    })),
    customerName: state.contact.customerName.trim().slice(0, MAX_NAME_LENGTH),
    phone: state.contact.phone.trim().slice(0, MAX_PHONE_LENGTH),
    // The customer's own words about when they would like it. NOT an agreed time -- F2 stores it in
    // fulfilment notes and leaves fulfillment_at null until the operator confirms.
    requestedTime: state.contact.requestedTime.trim().slice(0, MAX_REQUESTED_TIME_LENGTH),
    notes: state.contact.notes.trim().slice(0, MAX_NOTES_LENGTH),
    source: attribution.source,
    sourceRef: attribution.sourceRef,
    trap,
  };
}

// --- Attribution from the link ----------------------------------------------------------------------

// /order?source=instagram&ref=POST-184. The customer never sees or chooses these.
export function resolveAttribution(rawSource: string | undefined, rawRef: string | undefined): { source: OrderSource; sourceRef: string } {
  const source: OrderSource = typeof rawSource === "string" && isOrderSource(rawSource.trim()) ? (rawSource.trim() as OrderSource) : "unknown";
  // Opaque: passed through untouched, never parsed. Over-long is dropped rather than truncated,
  // matching F2 -- a corrupted-but-plausible reference is worse than none.
  const raw = typeof rawRef === "string" ? rawRef : "";
  return { source, sourceRef: raw.length > MAX_SOURCE_REF_LENGTH ? "" : raw };
}

// --- Applying a server response -----------------------------------------------------------------------

export type PublicOrderResponse =
  | { status: "accepted" }
  | { status: "invalid"; message: string }
  | { status: "prices-changed"; message: string; menu: PublicMenuProduct[] }
  | { status: "unavailable"; message: string; menu: PublicMenuProduct[] }
  | { status: "error"; message?: string };

const TEMPORARY_FAILURE = "We could not send that just now. Your order is still here — please try again in a moment.";

// The single place a response becomes new state.
//
// EVERY non-success branch keeps the contact details, the selections AND the idempotency key. The
// customer's work is never thrown away by a failure, and a retry is still the same logical order --
// which is exactly what makes F2's replay guarantee reachable.
export function applyResponse(state: PublicOrderFormState, response: PublicOrderResponse): PublicOrderFormState {
  switch (response.status) {
    case "accepted":
      // Terminal. The key is NOT rotated here -- it is retired with the whole state when the
      // customer starts a new order (startNewOrder), so an accidental resubmit of this same form
      // still carries the key F2 already knows about.
      return { ...state, status: { kind: "received" } };

    case "prices-changed":
      return { ...state, menu: response.menu, status: { kind: "prices-changed", message: response.message } };

    case "unavailable":
      return { ...state, menu: response.menu, status: { kind: "unavailable", message: response.message } };

    case "invalid":
      return { ...state, status: { kind: "invalid", message: response.message } };

    case "error":
      return { ...state, status: { kind: "error", message: response.message ?? TEMPORARY_FAILURE } };
  }
}

// A transport failure -- timeout, DNS, offline -- is the case idempotency exists for. It is
// indistinguishable from a response that was lost on the way back, so the order may well have been
// created. Keeping the key is what lets F2 answer the retry with a replay instead of a second order.
export function applyTransportFailure(state: PublicOrderFormState): PublicOrderFormState {
  return { ...state, status: { kind: "error", message: TEMPORARY_FAILURE } };
}

export function markSubmitting(state: PublicOrderFormState): PublicOrderFormState {
  return { ...state, status: { kind: "submitting" } };
}

// A genuinely NEW logical order: fresh key, fresh selections, fresh contact details. This is the
// only place a key is replaced, and it is reachable only after a successful order.
export function startNewOrder(state: PublicOrderFormState, newKey: () => string): PublicOrderFormState {
  return { menu: state.menu, quantities: {}, contact: { ...EMPTY_CONTACT }, idempotencyKey: newKey(), status: { kind: "editing" } };
}

// --- Product image safety ------------------------------------------------------------------------------

// Product.image is operator-entered free text with no validation anywhere in the app, and its own
// form describes it as "a photo file under public/product-images/". Rendering it unchecked on a
// public page would mean putting an arbitrary operator-typed string into an <img src> served to
// customers -- at best a broken image, at worst a request to a third-party host on every visitor's
// behalf.
//
// So only a same-origin path under that documented folder is rendered. Anything else is dropped and
// the card simply shows no photo. This is an allowlist, not an asset system: no upload, no proxy,
// no storage bucket.
export function getSafePublicImage(image: string): string | null {
  if (!image.startsWith("/product-images/")) return null;
  // No traversal, no protocol-relative escape, no query/fragment tricks.
  if (image.includes("..") || image.includes("//") || image.includes("\\") || image.includes("?") || image.includes("#")) return null;
  return /\.(png|jpe?g|webp|avif)$/i.test(image) ? image : null;
}
