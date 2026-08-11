// Runtime v1: live assembly of the canonical BusinessContext.
//
// This is the whole orchestration layer, and its smallness is the point. It resolves one BuildEnv,
// runs the four readers concurrently, and hands the results to the existing buildBusinessContext.
// It computes no fact, interprets no value, and makes no judgement about the business -- everything
// downstream of the reads is code that already shipped and is not modified here.
//
// Nothing is cached. Design section 6 is explicit: "Generated on demand. Never cached. No persisted
// snapshot as a cache -- ever." A cached business snapshot is one whose staleness is invisible, and
// the cost of not caching is a handful of indexed reads plus pure functions.

import { resolveBusinessDay, BUSINESS_TIMEZONE } from "../business-day.ts";
import { buildBusinessContext } from "./build.ts";
import { COSTING_FRESHNESS_COMPOSER } from "./composers/costing-freshness.ts";
import { readCosting, readInventory, readProducts, readReadiness, readSelling, type BusinessContextReadClient } from "./readers/supabase.ts";
import type { BusinessContext, BuildEnv } from "./types.ts";

export type BuildCurrentBusinessContextInput = {
  // Already authenticated, and supplied by the caller. This module neither creates a client nor
  // checks a session: whether there is a signed-in user to read as is a question the calling
  // surface answers before it gets here.
  client: BusinessContextReadClient;
  // Captured ONCE, at the caller's boundary. See resolveRuntimeEnv below.
  nowMs: number;
  timezone?: string;
};

// The single notion of "now" for one snapshot, in one place.
//
// Exported because it is the piece worth testing directly: every day-difference in the envelope is
// anchored to businessDay, and every adapter receives this same object, so a snapshot cannot contain
// two disagreeing notions of today.
//
// No clock is read here or anywhere below it. `nowMs` arrives from the caller -- the same discipline
// orders-page.tsx already applies with loadedAtMs, where one observation time stamps the whole
// dataset. A Date is constructed from nowMs inside resolveBusinessDay for formatting only; that is
// derivation from the injected instant, not a second reading of the clock.
export function resolveRuntimeEnv(nowMs: number, timezone: string = BUSINESS_TIMEZONE): BuildEnv {
  return {
    now: nowMs,
    timezone,
    businessDay: resolveBusinessDay(nowMs, timezone),
    // M1 ships no freshness budgets, and the values are an open owner decision (design section 13
    // Q6). Runtime v1 invents none rather than choosing numbers nobody has agreed to.
    budgets: {},
  };
}

// Reads live data and returns the canonical snapshot.
//
// PARTIAL FAILURE IS A SUCCESS PATH. The four reads run concurrently and independently; a domain
// that fails returns its ReadResult failure rather than throwing, and buildBusinessContext turns
// that into a degraded DomainContext plus a coverage.absent entry carrying the real reason. A
// snapshot with three healthy domains and one unavailable is far more useful than no snapshot,
// provided the gap is stated -- and it is never rendered as an empty business.
//
// Nothing here catches or suppresses an exception. A driver that throws instead of reporting an
// error is not a business fact, and swallowing it would manufacture exactly the quiet empty
// snapshot this architecture exists to prevent.
export async function buildCurrentBusinessContext({
  client,
  nowMs,
  timezone = BUSINESS_TIMEZONE,
}: BuildCurrentBusinessContextInput): Promise<BusinessContext> {
  const env = resolveRuntimeEnv(nowMs, timezone);

  // Concurrent and independent, in registry order. No reader consumes another's rows: Readiness
  // reads products and costing_summaries itself rather than waiting on Products or Costing, and
  // Selling depends on neither.
  const [products, costing, inventory, readiness, selling] = await Promise.all([
    readProducts(client, env),
    readCosting(client, env),
    readInventory(client, env),
    readReadiness(client, env),
    readSelling(client, env),
  ]);

  return buildBusinessContext({
    reads: { products, costing, inventory, readiness, selling },
    env,
    dataSource: "supabase",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });
}
