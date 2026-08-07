import { COSTING_UPDATED_AT_RELIABLE_FROM } from "../types.ts";
import type { DomainContext, DomainId, Fact, Signal, SignalComposer } from "../types.ts";
import type { CostingSnapshot } from "../adapters/costing.ts";

export const COSTING_FRESHNESS_COMPOSER_VERSION = 1;
export const COSTING_FRESHNESS_COMPOSER_ID = "costing-freshness";

// The one composed signal M1 ships.
//
// The question it answers: has this costing been reviewed since ingredient purchasing information
// changed? It compares two facts that live in different domains, which is exactly why it cannot be
// an adapter -- an adapter reads only its own tables.
//
// Pure, and structurally incapable of reading a row: the SignalComposer contract hands over finished
// DomainContext objects and no client. It re-derives neither timestamp; both arrive as published
// facts.
//
// Business-wide in v1, deliberately. CostingEntry carries ingredientName and no ingredientId, so a
// per-ingredient comparison would need a fuzzy name join and could only ever be inferred. No fuzzy
// matching, no ingredient join, no supplier read.
//
// No threshold. This is a direct timestamp comparison, so there is no number to tune and no
// business opinion to invent.

const INPUTS = ["costing.facts.byCosting[].reviewedAt", "inventory.facts.latestPurchaseAt"];

function provenance() {
  return {
    // A classification over two entered timestamps, not arithmetic.
    kind: "derived" as const,
    computedBy: "buildCostingFreshnessSignals",
    inputs: INPUTS,
  };
}

function signal(costingId: string, status: Signal["status"], message: string, recommendation: string, basis?: string): Signal {
  return {
    id: "costing.staleVsPurchases",
    domain: "cross-domain",
    scope: "cross-domain",
    subject: { kind: "costing", id: costingId },
    // A costing that has not been reviewed since a purchase is a prompt to look, not a blocker.
    severity: "warning",
    status,
    message,
    recommendation,
    provenance: basis ? { ...provenance(), basis } : provenance(),
  };
}

function knownValue<T>(fact: Fact<T> | undefined): T | undefined {
  if (fact && (fact.state === "known" || fact.state === "stale")) {
    return fact.value;
  }
  return undefined;
}

export const composeCostingFreshnessSignals: SignalComposer = (domains) => {
  const costing = domains.costing as DomainContext | undefined;
  const inventory = domains.inventory as DomainContext | undefined;

  // A composer over an unavailable domain emits nothing rather than guessing. The gap is already
  // visible in coverage.absent, and a signal that silently omits half its evidence is worse than no
  // signal at all.
  if (!costing?.readOutcome.ok || !inventory?.readOutcome.ok) {
    return [];
  }

  const snapshots = knownValue(costing.facts.byCosting as Fact<CostingSnapshot[]>);
  if (!snapshots || snapshots.length === 0) {
    return [];
  }

  const latestPurchaseFact = inventory.facts.latestPurchaseAt as Fact<string> | undefined;
  const latestPurchaseAt = knownValue(latestPurchaseFact);

  return snapshots.map((snapshot) => {
    // Nothing has ever been purchased. Not a pass and not a failure -- there is simply nothing to
    // compare against, and saying so is more useful than silence.
    if (latestPurchaseAt === undefined) {
      return signal(
        snapshot.costingId,
        "insufficient_data",
        "There are no recorded ingredient purchases to compare this costing against.",
        "Log ingredient purchases so costing freshness can be tracked.",
      );
    }

    // The costing's review time is not dependable: this row predates the point where update
    // timestamps started being maintained, so its timestamp records creation, not review. Reported
    // explicitly rather than omitted -- silence would be indistinguishable from "everything is fine".
    if (snapshot.reviewedAt.state !== "known") {
      return signal(
        snapshot.costingId,
        "insufficient_data",
        "Freshness cannot be determined reliably for this costing: no dependable record exists of when it was last reviewed.",
        "Re-open and save this costing to establish a reliable review time.",
        `Costing update timestamps are only dependable from ${COSTING_UPDATED_AT_RELIABLE_FROM}; this row predates that.`,
      );
    }

    const reviewedAt = snapshot.reviewedAt.value;

    if (Date.parse(reviewedAt) < Date.parse(latestPurchaseAt)) {
      // Reports only what the timestamps prove: a review has not been recorded since a purchase was
      // recorded. It does not claim the costing is wrong, or that any number is incorrect.
      return signal(
        snapshot.costingId,
        "fail",
        "This costing has not been reviewed since the latest recorded ingredient purchase.",
        "Review this costing against current ingredient prices.",
      );
    }

    return signal(
      snapshot.costingId,
      "pass",
      "This costing was reviewed after the latest recorded ingredient purchase.",
      "No action needed.",
    );
  });
};

export const COSTING_FRESHNESS_COMPOSER = {
  composerId: COSTING_FRESHNESS_COMPOSER_ID,
  version: COSTING_FRESHNESS_COMPOSER_VERSION,
  compose: composeCostingFreshnessSignals,
};

// Named export of the domains this composer depends on, so the >= 2-domain invariant is checkable
// without parsing the inputs array.
export const COSTING_FRESHNESS_INPUT_DOMAINS: readonly DomainId[] = ["costing", "inventory"];
