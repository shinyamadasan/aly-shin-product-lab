import type { Ingredient, SupplyEntry } from "./product-lab-types.ts";
import { describeIngredientConstraintError } from "./inventory-errors.ts";
import { formatPesos, formatPesosPerUnit, formatPurchaseDate } from "./inventory-display.ts";
import { convertToBaseUnit } from "./unit-conversion.ts";

// Cost verification (the operator-facing name for certify_ingredient_cost_baseline). Everything here
// is a pure helper: the database RPC stays the only authority that writes average_unit_cost /
// cost_reconciled_at, and it still requires a non-empty evidence note and its optimistic-concurrency
// check. This file only decides (a) whether the latest purchase is trustworthy enough to offer a
// one-click verification, what evidence note it generates, and (b) how a certify call's outcome --
// including an uncertain network timeout -- is classified and reconciled.

// ---------------------------------------------------------------------------------------------
// Latest purchase -> proposed cost + generated evidence note
// ---------------------------------------------------------------------------------------------

export type LatestPurchaseCost =
  | {
      usable: true;
      // Cost per the ingredient's own base unit (a kg purchase of a g ingredient is converted).
      unitCost: number;
      evidenceNote: string;
    }
  | { usable: false; reason: string };

function quantityText(quantity: number): string {
  return String(Number(quantity.toFixed(4)));
}

// Only ever built from a purchase that already passed resolveLatestPurchaseCost's validation, and
// only from fields that are present -- a missing brand/supplier/date is left out, never invented.
// Says "Latest purchase", never "receipt": a purchase record carries no receipt number here.
export function buildLatestPurchaseEvidenceNote(purchase: SupplyEntry, baseUnit: string, unitCost: number): string {
  const context = [purchase.brandName.trim(), purchase.supplierName.trim(), formatPurchaseDate(purchase.purchaseDate, { year: true })].filter(Boolean);
  const calculation = `${formatPesos(purchase.totalCost)} / ${quantityText(purchase.packQuantity)} ${purchase.unit.trim()} = ${formatPesosPerUnit(unitCost, baseUnit)}`;
  return `Latest purchase: ${[...context, calculation].join(" · ")}`;
}

// A purchase is only offered for one-click verification when its cost can be computed honestly:
// a positive finite pack quantity and total, a unit that converts to the ingredient's base unit
// (never a guess -- e.g. no volume-to-mass), and a resulting positive finite unit cost.
export function resolveLatestPurchaseCost(ingredient: Pick<Ingredient, "baseUnit">, purchase: SupplyEntry | undefined): LatestPurchaseCost {
  if (!purchase) {
    return { usable: false, reason: "No purchase has been recorded for this item yet." };
  }
  if (!Number.isFinite(purchase.packQuantity) || purchase.packQuantity <= 0) {
    return { usable: false, reason: "The latest purchase has no valid pack quantity." };
  }
  if (!Number.isFinite(purchase.totalCost) || purchase.totalCost <= 0) {
    return { usable: false, reason: "The latest purchase has no valid total cost." };
  }
  const unit = purchase.unit.trim();
  const baseQuantity = unit ? convertToBaseUnit(purchase.packQuantity, unit, ingredient) : null;
  if (baseQuantity === null || !Number.isFinite(baseQuantity) || baseQuantity <= 0) {
    return { usable: false, reason: "The latest purchase's unit can't be converted to this item's unit." };
  }
  const unitCost = purchase.totalCost / baseQuantity;
  if (!Number.isFinite(unitCost) || unitCost <= 0) {
    return { usable: false, reason: "The latest purchase doesn't give a valid unit cost." };
  }
  return { usable: true, unitCost, evidenceNote: buildLatestPurchaseEvidenceNote(purchase, ingredient.baseUnit, unitCost) };
}

// ---------------------------------------------------------------------------------------------
// Certification outcome: definite failure vs uncertain timeout, and the read-back that resolves it
// ---------------------------------------------------------------------------------------------

export type CertifyCostResult =
  // confirmedByReadBack: the RPC's own response was lost (timeout) but a fresh read proved it committed.
  // refreshed: whether the follow-up page-data reload succeeded (the certification itself is unaffected).
  | { status: "verified"; certifiedUnitCost: number; confirmedByReadBack: boolean; refreshed: boolean }
  | { status: "failed"; message: string }
  // The client genuinely cannot know whether the database committed. Never a "not verified" claim.
  | { status: "uncertain"; message: string };

export type CertifyIngredientCostBaseline = (
  ingredientId: string,
  certifiedUnitCost: number,
  evidenceNote: string,
  // Called once, only if the request's outcome is uncertain, right before the safe read-back starts.
  onCheckingResult?: () => void,
) => Promise<CertifyCostResult>;

export type CostState = { averageUnitCost: number | null; costReconciledAt: string | null };

export type RpcOutcome = {
  error: { code?: string | null; message: string } | null;
  // HTTP status of the response; 0 when the request never got one (network failure).
  status?: number;
};

// A gateway/transport failure -- the request may or may not have reached (and committed in) the
// database. Deliberately NOT triggered by an error that carries a code: Postgres/PostgREST errors
// (including 40001 "changed", 42501, and statement_timeout 57014) come back as JSON with a code
// only after the database has answered, meaning the transaction did not commit. What has no code is
// the gateway's own plain-text body ("upstream request timeout" is postgrest-js's error.message for
// a non-JSON 504) or a fetch failure.
const TRANSPORT_FAILURE_TEXT = /timeout|timed out|upstream|gateway|failed to fetch|fetch failed|network|abort|socket|econn/i;

export function isUncertainTransportFailure(outcome: RpcOutcome): boolean {
  const { error, status } = outcome;
  if (!error || error.code) {
    return false;
  }
  return status === 0 || status === 408 || (status !== undefined && status >= 500) || TRANSPORT_FAILURE_TEXT.test(error.message);
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a === b || Date.parse(a) === Date.parse(b);
}

function sameCost(a: number | null, b: number | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

export type ReadBackVerdict = "committed" | "unchanged" | "changed";

// cost_reconciled_at is set to a fresh clock_timestamp() by every successful certification, so a
// changed value plus our exact certified cost proves this request committed.
export function classifyCostReadBack(before: CostState, after: CostState, certifiedUnitCost: number): ReadBackVerdict {
  if (sameInstant(before.costReconciledAt, after.costReconciledAt) && sameCost(before.averageUnitCost, after.averageUnitCost)) {
    return "unchanged";
  }
  if (after.costReconciledAt !== null && !sameInstant(before.costReconciledAt, after.costReconciledAt) && sameCost(after.averageUnitCost, certifiedUnitCost)) {
    return "committed";
  }
  return "changed";
}

export type CertifyCostIo = {
  // A fresh, direct read of the raw values (null on any read failure) -- never the lossy client type.
  readState: () => Promise<CostState | null>;
  // Exactly one RPC per call; the database's own optimistic-concurrency check compares
  // expectedCurrentCost (the fresh average_unit_cost) plus quantity / latest ledger row.
  callRpc: (expectedCurrentCost: number | null) => Promise<RpcOutcome>;
  onCheckingResult?: () => void;
};

export const UNCERTAIN_UNREADABLE_MESSAGE =
  "Verification result is uncertain because the request timed out and the item could not be re-read to check. Don't submit again yet -- reload the page and check whether this item now shows Verified.";
export const TIMEOUT_NOT_SAVED_MESSAGE = "The request timed out and the cost was not saved. You can try again.";
export const CHANGED_DURING_TIMEOUT_MESSAGE =
  "The request timed out, and this item's cost changed in a way that doesn't match what you submitted. Reload and review the item before trying again.";

// The single place a certify attempt is orchestrated. Never retries: the RPC is called at most once,
// and a timeout is resolved only by a read -- so a blind retry can never create a second audit row.
export async function runCostCertification(io: CertifyCostIo, certifiedUnitCost: number): Promise<CertifyCostResult> {
  const before = await io.readState();
  if (!before) {
    return { status: "failed", message: "Could not read the current cost before verifying. Reload and try again." };
  }

  let outcome: RpcOutcome;
  try {
    outcome = await io.callRpc(before.averageUnitCost);
  } catch (thrown) {
    outcome = { error: { message: thrown instanceof Error ? thrown.message : "request failed" }, status: 0 };
  }

  if (!outcome.error) {
    return { status: "verified", certifiedUnitCost, confirmedByReadBack: false, refreshed: true };
  }
  if (!isUncertainTransportFailure(outcome)) {
    return { status: "failed", message: `Could not verify cost: ${describeIngredientConstraintError({ code: outcome.error.code ?? "", message: outcome.error.message })}` };
  }

  io.onCheckingResult?.();
  const after = await io.readState();
  if (!after) {
    return { status: "uncertain", message: UNCERTAIN_UNREADABLE_MESSAGE };
  }
  const verdict = classifyCostReadBack(before, after, certifiedUnitCost);
  if (verdict === "committed") {
    return { status: "verified", certifiedUnitCost, confirmedByReadBack: true, refreshed: true };
  }
  return verdict === "unchanged"
    ? { status: "failed", message: TIMEOUT_NOT_SAVED_MESSAGE }
    : { status: "uncertain", message: CHANGED_DURING_TIMEOUT_MESSAGE };
}

export const CHECKING_RESULT_MESSAGE = "Verification result is uncertain because the request timed out. Reloading the item to check whether it was saved...";

export function verifiedCostMessage(certifiedUnitCost: number, baseUnit: string): string {
  return `Cost verified at ${formatPesosPerUnit(certifiedUnitCost, baseUnit)}.`;
}
