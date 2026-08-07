import { evaluateProduct } from "../../rule-engine/index.ts";
import type { RuleResult } from "../../rule-engine/index.ts";
import { mapCostingSummaryRow, mapProductBatchRow, mapProductRow, mapTastingFeedbackRow } from "../../supabase-mappers.ts";
import type { CostingSummaryRow, ProductBatchRow, ProductRow, TastingFeedbackRow } from "../../supabase-mappers.ts";
import { SIGNAL_IDS } from "../types.ts";
import type { BuildEnv, DomainContext, Provenance, ReadOutcome, Signal, SignalId, SignalSeverity } from "../types.ts";

export const READINESS_ADAPTER_VERSION = 1;

// D1 = Option A. The Readiness reader declares the Rule Engine's complete input contract as its own
// read set: products, product_batches, costing_summaries, tasting_feedback.
//
// Four reasons this does not violate "an adapter reads only its own tables" and does not expand the
// milestone:
//
//   - RuleEngineContext is a single, existing, published interface. Satisfying it partially does not
//     produce a partially-correct result; it produces confidently wrong insufficient_data. The
//     domain's "own tables" are the tables its calculator's contract names.
//   - No fact is duplicated. This domain publishes signals only -- `facts` is empty by design -- so
//     costing_summaries being read by two readers creates no second source of truth. The Costing
//     adapter remains the only publisher of costing facts.
//   - No ordering dependency. Readiness never waits on, reads from, or depends on another adapter
//     completing, which is what keeps adapters parallelisable and a broken domain survivable.
//   - The milestone does not grow. No Product, Batch, or Tasting domain adapter is added -- no
//     DomainContext, no facts, no signals for those domains. Only raw reads feeding one calculator.
//
// The cost is that costing_summaries is read twice per build. A few hundred rows in a
// single-operator app, in exchange for domain independence.
export type ReadinessRows = {
  products: ProductRow[];
  batches: ProductBatchRow[];
  costings: CostingSummaryRow[];
  tastings: TastingFeedbackRow[];
};

// QUAL-001/002/003/005 evaluate shelf-life, temperature, and packaging tests by keyword search over
// free-text batch and costing notes, because no schema field exists for any of them. A pass there is
// weaker evidence than a pass in Financial or Production, and the provenance has to say so -- a
// context that presents them identically is lying by omission.
const FREE_TEXT_RULE_IDS = new Set(["QUAL-001", "QUAL-002", "QUAL-003", "QUAL-005"]);

// Categories whose results are degraded in M1 because their inputs are deliberately not loaded.
// The distinction that matters: this is milestone scope, not a finding about the business.
const MILESTONE_SCOPE_NOTE =
  "Supply-category results are insufficient_data because the Supplies domain is not part of this milestone -- not because the business lacks purchase history.";

function isKnownSignalId(id: string): id is SignalId {
  return (SIGNAL_IDS as readonly string[]).includes(id);
}

function toStatus(passed: boolean | null): Signal["status"] {
  if (passed === true) return "pass";
  if (passed === false) return "fail";
  return "insufficient_data";
}

function toSeverity(severity: RuleResult["severity"]): SignalSeverity {
  // RuleSeverity and SignalSeverity are the same three values; mapped explicitly so a future
  // divergence in either vocabulary fails here rather than silently mis-grading a signal.
  return severity;
}

function provenanceFor(rule: RuleResult, productId: string): Provenance {
  if (FREE_TEXT_RULE_IDS.has(rule.id)) {
    return {
      kind: "inferred",
      computedBy: "evaluateProduct",
      inputs: ["readiness.signals"],
      rowIds: [productId],
      basis:
        "Evaluated by keyword search over free-text batch and costing notes; no dedicated schema field records this test, " +
        "so a pass here is weaker evidence than an arithmetic or presence check.",
    };
  }

  return {
    kind: "derived",
    computedBy: "evaluateProduct",
    inputs: ["readiness.signals"],
    rowIds: [productId],
  };
}

function toSignal(rule: RuleResult, productId: string): Signal | null {
  // A rule id outside the published vocabulary is dropped rather than emitted: SIGNAL_IDS is the
  // contract dashboards and alerts bind to, and widening it silently would break that guarantee.
  // The types test asserts the engine's ids are all declared, so this branch should be unreachable.
  if (!isKnownSignalId(rule.id)) {
    return null;
  }

  return {
    id: rule.id,
    domain: "readiness",
    scope: "domain",
    subject: { kind: "product", id: productId },
    severity: toSeverity(rule.severity),
    status: toStatus(rule.passed),
    message: rule.message,
    recommendation: rule.recommendation,
    provenance: provenanceFor(rule, productId),
  };
}

function unavailableContext(because: string, outcome: ReadOutcome, state: "unavailable" | "not_configured"): DomainContext {
  return {
    domain: "readiness",
    adapterVersion: READINESS_ADAPTER_VERSION,
    readOutcome: outcome,
    sourceAsOf: state === "not_configured" ? { state: "not_configured", because } : { state: "unavailable", because },
    rowCounts: { read: 0, included: 0, omitted: 0 },
    // Empty even on failure: this domain never publishes facts, in any state.
    facts: {},
    signals: [],
    notes: [because],
  };
}

export function buildReadinessDomainContextFromFailure(outcome: Extract<ReadOutcome, { ok: false }>): DomainContext {
  if (outcome.reason === "missing-table") {
    return unavailableContext("One or more Rule Engine input tables do not exist in this project yet.", outcome, "not_configured");
  }
  return unavailableContext(`The Rule Engine input read failed: ${outcome.message}`, outcome, "unavailable");
}

export function buildReadinessDomainContext(rows: ReadinessRows, env: BuildEnv): DomainContext {
  const products = rows.products.map(mapProductRow);

  const context = {
    batches: rows.batches.map(mapProductBatchRow),
    costings: rows.costings.map(mapCostingSummaryRow),
    tastings: rows.tastings.map(mapTastingFeedbackRow),
    // Deliberately empty, and disclosed in notes below. Supply rules degrade to insufficient_data,
    // which is honest -- provided a reader can tell that we did not look, rather than that we looked
    // and found nothing.
    supplies: [],
    // now is injected, never read inside a rule, so staleness checks stay reproducible.
    now: env.now,
  };

  const signals: Signal[] = [];
  let omitted = 0;

  for (const product of products) {
    // includeLaunch stays false: launch composite gates only run when a launch decision is actually
    // being evaluated, matching the engine's own documented default. That is a view concern, and
    // views are out of scope for this milestone.
    const result = evaluateProduct(product, context, { includeLaunch: false });

    for (const rule of result.ruleResults) {
      const signal = toSignal(rule, product.id);
      if (signal === null) {
        omitted += 1;
        continue;
      }
      signals.push(signal);
    }
  }

  return {
    domain: "readiness",
    adapterVersion: READINESS_ADAPTER_VERSION,
    readOutcome: { ok: true },
    // A derived domain has no rows of its own to be "as of". Its inputs' currency is reported by the
    // domains that own those tables.
    //
    // No `inputs` here, deliberately. The computedBy/inputs requirement applies to facts that
    // actually carry a computed value -- `known` and `stale`. This fact is `unknown`: nothing was
    // computed, so there is no dependency to name, and adding one would be a fabricated claim
    // rather than traceability. See the provenance invariant test for the exact scoping.
    sourceAsOf: {
      state: "unknown",
      because: "Readiness is derived from other domains' tables and has no source rows of its own.",
      source: { kind: "derived", computedBy: "buildReadinessDomainContext" },
    },
    rowCounts: { read: products.length, included: signals.length, omitted },
    // Empty by design. This is precisely what makes the duplicated costing_summaries read safe:
    // no fact is published here, so there is no second source of truth for anything.
    facts: {},
    signals,
    notes: [
      MILESTONE_SCOPE_NOTE,
      "Selling Format data is not loaded in this milestone, so QUAL-002 reports insufficient_data for scope reasons rather than as a finding about packaging.",
      "QUAL-001/002/003/005 are evaluated by keyword search over free text; their provenance is marked inferred and they must not be read as strongly as arithmetic checks.",
      "Launch composite gates are not evaluated: includeLaunch is false, matching the Rule Engine's own default for routine evaluation.",
    ],
  };
}
