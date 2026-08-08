// S9 PR-F2: the public order submission endpoint.
//
// The repository's FIRST server execution boundary. A customer's browser reaches this with no
// Supabase credential of any kind; everything commercial is decided on this side of the line.
//
// This file is deliberately thin. All decisions live in src/lib/public-order-service.ts so they can
// be tested with stubs; the only job here is HTTP: read the body within a size cap, hand it over,
// and translate the outcome into a status code and a sanitized body.
//
// There is exactly ONE route and it is a POST. No GET, no order-status lookup, no customer lookup --
// an idempotency key must never become a way to read an order back.

import { withPublicOrderClient } from "@/lib/supabase-server";
import { submitPublicOrder, type PublicOrderOutcome } from "@/lib/public-order-service";
import { MAX_PAYLOAD_BYTES } from "@/lib/orders/public-submission";
import type { OrdersClient } from "@/lib/orders-repository";
import type { PublicCatalogClient } from "@/lib/public-catalog-repository";

// Node runtime: the Supabase client and Web Crypto both run here, and the module-scope session
// reuse in supabase-server.ts depends on a real Node instance rather than an edge isolate.
export const runtime = "nodejs";
// Never statically evaluated or cached -- every submission is a fresh write path.
export const dynamic = "force-dynamic";

// The public error contract. Five stable classes, and none of them carries a PostgreSQL message, a
// table name, a stack, a Supabase auth error, or an internal identifier.
function toResponse(outcome: PublicOrderOutcome): Response {
  switch (outcome.kind) {
    case "accepted":
      // Identical for a first submission and a replay, by design.
      return Response.json({ status: "accepted" }, { status: 200 });
    case "invalid":
      return Response.json({ status: "invalid", message: outcome.message }, { status: 400 });
    case "prices-changed":
      return Response.json({ status: "prices-changed", message: outcome.message, menu: outcome.menu }, { status: 409 });
    case "unavailable":
      return Response.json({ status: "unavailable", message: outcome.message, menu: outcome.menu }, { status: 409 });
    case "error":
      // Covers a failed sign-in of the website principal as well as any database failure. The
      // customer is told the truth at the only level that concerns them: try again shortly.
      return Response.json({ status: "error", message: "We could not take that order just now. Please try again in a moment." }, { status: 503 });
  }
}

export async function POST(request: Request): Promise<Response> {
  // Size cap before parsing, so a large body is never turned into objects. Content-Length is a
  // claim, so the actual text is measured too.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAYLOAD_BYTES) {
    return toResponse({ kind: "invalid", message: "That order is too large to submit." });
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_PAYLOAD_BYTES) {
      return toResponse({ kind: "invalid", message: "That order is too large to submit." });
    }
    body = JSON.parse(text);
  } catch {
    return toResponse({ kind: "invalid", message: "That order could not be read. Please try again." });
  }

  try {
    // Runs through the recovery wrapper rather than a bare client: if the submission comes back as
    // an internal failure -- typically a session that expired while this serverless instance was
    // warm -- the principal re-authenticates ONCE and the submission is retried ONCE. The retry is
    // safe because the flow is idempotent: the order id is derived from the submitted key, so the
    // second attempt either finds the order already created or creates it exactly once.
    const attempt = await withPublicOrderClient(
      (client) =>
        submitPublicOrder(
          {
            ordersClient: client as unknown as OrdersClient,
            catalogClient: client as unknown as PublicCatalogClient,
            now: new Date().toISOString(),
          },
          body,
        ),
      // Only an internal failure is worth re-authenticating for. A rejected submission -- invalid,
      // prices-changed, unavailable -- is a settled answer and must never be retried.
      (outcome) => outcome.kind === "error",
    );

    // A second failure is not retried again. The customer is told the one thing that concerns them.
    return toResponse(attempt.ok ? attempt.result : { kind: "error" });
  } catch {
    // Nothing about an unexpected failure travels to the customer.
    return toResponse({ kind: "error" });
  }
}
