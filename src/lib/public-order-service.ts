// S9 PR-F2: the public submission flow, with its dependencies injected.
//
// The Route Handler is a thin HTTP wrapper over this. Keeping the decisions here means the whole
// trust boundary is testable with hand-built stubs and no HTTP server -- including the two
// invariants that matter most: a hostile price cannot become a recorded price, and a replayed
// submission cannot rewrite an order that already exists.
//
// Order of operations, and why it is this order:
//
//   parse  ->  honeypot  ->  derive ids  ->  replay check (optimization only)
//          ->  load the SERVER's catalog  ->  resolve items + price consent
//          ->  build  ->  atomic create-once gate (-> save_order)
//
// The replay check comes BEFORE the catalog deliberately. An order that already exists was created
// at the price and availability of its own moment; nothing that happens to the catalog afterwards
// can retroactively make that submission invalid. Resolving first meant a customer whose response
// was lost -- the exact case idempotency exists for -- was told "prices have changed" for an order
// that had already been placed.
//
// Everything that can reject the submission happens before anything is written, so a rejected
// request leaves no customer row, no order, and no lines.
//
// The final step is a database-atomic gate rather than another application-side check. An earlier
// revision assumed a read-then-write in application code was sufficient; live concurrency testing
// disproved it, and a second caller reset a confirmed, paid order. See section 6 Q2 of the frozen
// plan, which is authoritative at Revision 3.

import { getPublicMenu, getPublicSellableGroups, type PublicMenuProduct } from "./orders/public-menu.ts";
import { derivePublicCustomerId, derivePublicOrderId } from "./orders/public-order-id.ts";
import { buildPublicCustomer, buildPublicOrder, parsePublicOrderRequest, resolvePublicOrderLines } from "./orders/public-submission.ts";
import { getOrderDetail, submitPublicOrderOnce, type OrdersClient } from "./orders-repository.ts";
import { loadPublicCatalog, type PublicCatalogClient } from "./public-catalog-repository.ts";

export type PublicOrderOutcome =
  // Deliberately boring, and deliberately identical for a first submission and a replay.
  | { kind: "accepted" }
  | { kind: "invalid"; message: string }
  | { kind: "prices-changed"; message: string; menu: PublicMenuProduct[] }
  | { kind: "unavailable"; message: string; menu: PublicMenuProduct[] }
  | { kind: "error" };

export type PublicOrderDeps = {
  ordersClient: OrdersClient;
  catalogClient: PublicCatalogClient;
  now: string;
};

const GENERIC_INVALID = "That order could not be placed. Please review it and try again.";

export async function submitPublicOrder({ ordersClient, catalogClient, now }: PublicOrderDeps, rawBody: unknown): Promise<PublicOrderOutcome> {
  const parsed = parsePublicOrderRequest(rawBody);
  if (!parsed.ok) {
    return { kind: "invalid", message: parsed.message };
  }
  const request = parsed.request;

  // Honeypot: a field no human ever sees. A filled one is a bot, and the useful response is the
  // same success a real submission gets -- telling a bot it failed only teaches it to try again.
  // Nothing is written.
  if (request.trap !== "") {
    return { kind: "accepted" };
  }

  const orderId = await derivePublicOrderId(request.idempotencyKey);
  const customerId = await derivePublicCustomerId(request.idempotencyKey);

  // ---- Replay, answered BEFORE the catalog is consulted -----------------------------------------
  //
  // An order that already exists was created at the price and availability of the moment it was
  // created. Nothing that happens to the catalog afterwards can retroactively make that submission
  // invalid, so a retry is answered from existence alone.
  //
  // This check used to sit after catalog resolution, which meant a customer whose response was lost
  // -- the exact case idempotency exists for -- got "prices have changed" or "no longer available"
  // for an order that had in fact already been placed. Worse for an order that had since been
  // confirmed and paid.
  //
  // It remains OPTIMIZATION-ONLY for concurrency: it and the write below are separate transactions,
  // so a caller can pass it and then pause while another writer creates the order. That is
  // save_public_order_once's job, and a caller that races past this check is still safe.
  const existing = await getOrderDetail(ordersClient, orderId);
  if (existing.ok) {
    return { kind: "accepted" };
  }
  if (existing.reason !== "not-found") {
    return { kind: "error" };
  }

  const catalog = await loadPublicCatalog(catalogClient);
  if (!catalog.ok) {
    return { kind: "error" };
  }

  // The authoritative menu, rebuilt from the database on every submission. A menu object sent by
  // the browser is never consulted -- it is not even part of the request contract.
  const groups = getPublicSellableGroups(catalog.catalog.products, catalog.catalog.batches, catalog.catalog.costings, catalog.catalog.sellingFormats);

  const resolved = resolvePublicOrderLines(request, groups, orderId);
  if (!resolved.ok) {
    // Both rejections hand back the refreshed menu so the customer can see what actually changed.
    // Neither writes anything.
    const menu = getPublicMenu(catalog.catalog.products, catalog.catalog.batches, catalog.catalog.costings, catalog.catalog.sellingFormats);
    return resolved.reason === "prices-changed"
      ? { kind: "prices-changed", message: resolved.message, menu }
      : { kind: "unavailable", message: resolved.message, menu };
  }

  const order = buildPublicOrder(request, { orderId, customerId, now });
  const customer = buildPublicCustomer(request, { customerId, now });

  // ---- THE CORRECTNESS BOUNDARY -----------------------------------------------------------------
  //
  // Creation goes through the atomic gate: one transaction takes an advisory lock on the derived
  // order id, checks existence under it, and only then delegates to save_order. A second caller for
  // the same id waits, sees the committed row, and returns created:false having written nothing --
  // so it can never reset the lifecycle or payment facts the order has acquired in the meantime.
  const saved = await submitPublicOrderOnce(ordersClient, { order, lines: resolved.lines, newCustomer: customer, now });
  if (!saved.ok) {
    // A persistence failure is a SERVER failure. Returning it as `invalid` would give the customer
    // a 400 and send them editing an order that was never the problem. Either way the repository's
    // message can name a table or a database error, so it never reaches the public.
    return saved.reason === "failed" ? { kind: "error" } : { kind: "invalid", message: GENERIC_INVALID };
  }

  // created:false means we lost the race. That is a replay, and it looks exactly like one.
  return { kind: "accepted" };
}
