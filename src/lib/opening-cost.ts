import type { CanonicalUnit, Ingredient, SupplyEntry } from "./product-lab-types.ts";
import { describeIngredientConstraintError } from "./inventory-errors.ts";
import { formatPesos, formatPesosPerUnit, formatPurchaseDate } from "./inventory-display.ts";
import { convertToBaseUnit } from "./unit-conversion.ts";

// Opening Cost Setup (the operator-facing name for the certify_ingredient_cost_baseline RPC, which
// keeps its name -- only the words the operator sees changed). Cost trust is automatic in normal
// operation: a priced purchase establishes or preserves it in the database, atomically with the
// purchase. This is the one exceptional action, for stock that existed before reliable cost tracking.
// Everything here is a pure helper: the database RPC stays the only authority that writes
// average_unit_cost / cost_reconciled_at, and it still requires a non-empty evidence note and its
// optimistic-concurrency check. This file only decides (a) whether the latest purchase is usable as
// the opening cost basis and what evidence note it generates, (b) how manually entered facts
// (paid / quantity / unit) become a unit cost and evidence note, and (c) how a setup call's outcome --
// including an uncertain network timeout -- is classified and reconciled.

// ---------------------------------------------------------------------------------------------
// Latest purchase -> proposed opening cost + generated evidence note
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
// Says it is an opening cost BASIS taken from the latest purchase (the purchase itself is untouched),
// and never "receipt": a purchase record carries no receipt number here.
export function buildLatestPurchaseEvidenceNote(purchase: SupplyEntry, baseUnit: string, unitCost: number): string {
  const context = [purchase.brandName.trim(), purchase.supplierName.trim(), formatPurchaseDate(purchase.purchaseDate, { year: true })].filter(Boolean);
  const calculation = `${formatPesos(purchase.totalCost)} / ${quantityText(purchase.packQuantity)} ${purchase.unit.trim()} = ${formatPesosPerUnit(unitCost, baseUnit)}`;
  return `Opening cost basis from latest purchase: ${calculation}${context.length > 0 ? ` (${context.join(" · ")})` : ""}`;
}

// A purchase is only offered as the one-click opening cost when its cost can be computed honestly:
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

// The operator recognises what they paid and received, not a unit price: these are the two spellings
// of those purchase facts (the unit cost is always the derived, secondary output).
// "PHP 19.00 for 50 g" -- the panel's primary line.
export function formatPurchaseFacts(totalPaid: number, quantity: number, unit: string): string {
  return `${formatPesos(totalPaid)} for ${quantityText(quantity)} ${unit.trim()}`.trim();
}

// "PHP 19 / 50 g" -- the collapsed row's compact form (whole pesos drop the ".00").
export function formatPurchaseCompact(totalPaid: number, quantity: number, unit: string): string {
  return `${formatPesos(totalPaid).replace(/\.00$/, "")} / ${quantityText(quantity)} ${unit.trim()}`.trim();
}

// ---------------------------------------------------------------------------------------------
// Manual opening cost: real-world facts -> unit cost + generated evidence note
// ---------------------------------------------------------------------------------------------

// The operator enters what they paid, how much they got and in which unit -- never a unit price.
// The conversion is unit-conversion.ts's (no second system): a unit that does not convert to the
// ingredient's base unit is rejected, never guessed. Positive money is always required; free or
// unknown-cost stock is a separate policy decision and is deliberately not accepted here. The
// facts describe the cost of the stock the Item holds now -- an opening cost basis, not a purchase.
export type ManualCostBasis =
  // Not enough entered yet to say anything -- the UI shows no calculated cost and no error.
  | { status: "incomplete" }
  | { status: "invalid"; reason: string }
  // unitCost is per the ingredient's base unit, at full precision (only the display is rounded).
  | { status: "ok"; unitCost: number; evidenceNote: string };

export type ManualCostInput = { totalPaid: string | number; quantity: string | number; unit: string };

// The units offered for a manual cost, limited to those that convert to the ingredient's base unit.
const MANUAL_COST_UNIT_CANDIDATES = ["g", "kg", "ml", "L", "pcs"];

export function manualCostUnitOptions(baseUnit: CanonicalUnit): string[] {
  return MANUAL_COST_UNIT_CANDIDATES.filter((unit) => convertToBaseUnit(1, unit, { baseUnit }) !== null);
}

// Raw entered amount, raw entered quantity and unit, and the calculated per-base-unit cost, so the
// audit note shows both what the operator entered and what was set.
export function buildManualCostEvidence(totalPaid: number, quantity: number, unit: string, baseUnit: string, unitCost: number): string {
  return `Opening cost basis: ${formatPesos(totalPaid)} / ${quantityText(quantity)} ${unit.trim()} = ${formatPesosPerUnit(unitCost, baseUnit)}`;
}

export function calculateManualCostBasis(ingredient: Pick<Ingredient, "baseUnit">, input: ManualCostInput): ManualCostBasis {
  const totalRaw = String(input.totalPaid).trim();
  const quantityRaw = String(input.quantity).trim();
  const unit = input.unit.trim();
  if (!totalRaw || !quantityRaw || !unit) {
    return { status: "incomplete" };
  }
  const totalPaid = Number(totalRaw);
  const quantity = Number(quantityRaw);
  if (!Number.isFinite(totalPaid) || !Number.isFinite(quantity)) {
    return { status: "invalid", reason: "Enter the amounts as numbers." };
  }
  if (totalPaid <= 0) {
    return { status: "invalid", reason: "Total paid must be greater than zero." };
  }
  if (quantity <= 0) {
    return { status: "invalid", reason: "Quantity must be greater than zero." };
  }
  const baseQuantity = convertToBaseUnit(quantity, unit, ingredient);
  if (baseQuantity === null || !Number.isFinite(baseQuantity) || baseQuantity <= 0) {
    return { status: "invalid", reason: `That unit cannot be converted to this ingredient's base unit (${ingredient.baseUnit}).` };
  }
  const unitCost = totalPaid / baseQuantity;
  if (!Number.isFinite(unitCost) || unitCost <= 0) {
    return { status: "invalid", reason: "Those amounts don't give a valid unit cost." };
  }
  return { status: "ok", unitCost, evidenceNote: buildManualCostEvidence(totalPaid, quantity, unit, ingredient.baseUnit, unitCost) };
}

// ---------------------------------------------------------------------------------------------
// Setup outcome: definite failure vs uncertain timeout, and the read-back that resolves it
// ---------------------------------------------------------------------------------------------

export type OpeningCostResult =
  // confirmedByReadBack: the RPC's own response was lost (timeout) but a fresh read proved it committed.
  | { status: "saved"; unitCost: number; confirmedByReadBack: boolean }
  | { status: "failed"; message: string }
  // The client genuinely cannot know whether the database committed. Never a "not saved" claim.
  | { status: "uncertain"; message: string }
  // Refused before anything was sent: an attempt for this Item is already running, unconfirmed, or
  // saved and still waiting for the list to refresh (see OpeningCostAttemptTracker).
  | { status: "blocked"; message: string };

export type SetOpeningCostBasis = (
  ingredientId: string,
  unitCost: number,
  evidenceNote: string,
  // Called once, only if the request's outcome is uncertain, right before the safe read-back starts.
  onCheckingResult?: () => void,
) => Promise<OpeningCostResult>;

// What is holding an Item's setup: a request still running, an outcome nobody could confirm, or a
// save that succeeded but whose fresh data has not reached the list yet.
export type OpeningCostAttempt = "in-flight" | "uncertain" | "saved";

// One entry per Item with a setup in flight, unconfirmed, or saved-but-not-yet-visible. It lives above
// the panel (in the page component), so closing and reopening the panel -- which discards the panel's
// own state -- can never make a second submit possible while the first is still running, its outcome
// is unknown, or the list still shows the Item as needing setup because a background refresh has not
// landed. "uncertain" is only cleared by a page reload, which is exactly what the operator is told to
// do. "saved" is cleared by settle() when the refreshed data arrives (if the refresh fails it stays,
// because the list is still stale). A failed attempt clears immediately: nothing was written.
//
// It is subscribable so a panel or row that was closed during the attempt renders the right state the
// moment it opens, and updates when the attempt resolves, instead of discovering the block on click.
export type OpeningCostAttemptTracker = {
  // The blocking state for this Item, or null when a new submit is safe.
  blocked: (ingredientId: string) => OpeningCostAttempt | null;
  begin: (ingredientId: string) => void;
  finish: (ingredientId: string, result: OpeningCostResult) => void;
  // The refreshed data that shows this Item as set up has arrived.
  settle: (ingredientId: string) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createOpeningCostAttemptTracker(): OpeningCostAttemptTracker {
  const attempts = new Map<string, OpeningCostAttempt>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    blocked: (ingredientId) => attempts.get(ingredientId) ?? null,
    begin: (ingredientId) => { attempts.set(ingredientId, "in-flight"); notify(); },
    finish: (ingredientId, result) => {
      if (result.status === "uncertain") {
        attempts.set(ingredientId, "uncertain");
      } else if (result.status === "saved") {
        attempts.set(ingredientId, "saved");
      } else {
        attempts.delete(ingredientId);
      }
      notify();
    },
    settle: (ingredientId) => {
      if (attempts.get(ingredientId) === "saved") {
        attempts.delete(ingredientId);
        notify();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

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

// cost_reconciled_at is set to a fresh clock_timestamp() by every successful setup, so a changed
// value plus our exact cost proves this request committed.
export function classifyCostReadBack(before: CostState, after: CostState, unitCost: number): ReadBackVerdict {
  if (sameInstant(before.costReconciledAt, after.costReconciledAt) && sameCost(before.averageUnitCost, after.averageUnitCost)) {
    return "unchanged";
  }
  if (after.costReconciledAt !== null && !sameInstant(before.costReconciledAt, after.costReconciledAt) && sameCost(after.averageUnitCost, unitCost)) {
    return "committed";
  }
  return "changed";
}

// A request that has not answered by then is treated exactly like the gateway's own timeout: an
// uncertain outcome resolved by a read-back. The database's statement timeout is far shorter than
// this, so a healthy request never reaches it; it only bounds how long the button can wait.
export const OPENING_COST_REQUEST_DEADLINE_MS = 15_000;

export type OpeningCostIo = {
  // A fresh, direct read of the raw values (null on any read failure) -- never the lossy client type.
  // The signal is aborted when the deadline passes; honoring it is an optimization, not a requirement.
  readState: (signal?: AbortSignal) => Promise<CostState | null>;
  // Exactly one RPC per call; the database's own optimistic-concurrency check compares
  // expectedCurrentCost (the fresh average_unit_cost) plus quantity / latest ledger row.
  callRpc: (expectedCurrentCost: number | null, signal?: AbortSignal) => Promise<RpcOutcome>;
  onCheckingResult?: () => void;
  // Overrides OPENING_COST_REQUEST_DEADLINE_MS (tests use a tiny value).
  deadlineMs?: number;
};

export const UNCERTAIN_UNREADABLE_MESSAGE =
  "The result is uncertain because the request timed out and the Item could not be re-read to check. Don't submit again yet -- reload the page and check whether this Item still needs an opening cost.";
// An unchanged read-back right after a timeout is strong evidence, not proof -- a slow request could
// still commit later -- so this never claims the cost "was not saved", and it is an uncertain (locked)
// outcome, not a definite failure: submitting again before the owner has checked is the one thing to prevent.
export const TIMEOUT_NOT_SAVED_MESSAGE =
  "The request timed out and no saved change was found yet. Reload and check whether this Item still needs an opening cost before retrying.";
export const CHANGED_DURING_TIMEOUT_MESSAGE =
  "The request timed out, and this Item's cost changed in a way that doesn't match what you submitted. Reload and review the Item before trying again.";

// What a blocked Item says, whichever surface asks (the panel on open, or a submit that is refused).
export const ATTEMPT_MESSAGES: Record<OpeningCostAttempt, string> = {
  "in-flight": "An opening cost for this Item is still being saved. Wait a moment, or reload the page to see where it stands.",
  uncertain: "The last attempt to set this Item's opening cost has an unconfirmed result. Reload the page and check whether it still needs an opening cost before trying again.",
  saved: "Opening cost saved. Updating the list...",
};

class DeadlineExceeded extends Error {
  constructor() {
    super("request timed out on this device");
  }
}

// Runs one request under the deadline. The abort is best-effort (it releases the connection); the
// race is what guarantees the caller moves on even if the request ignores the signal.
async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, deadlineMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new DeadlineExceeded()); }, deadlineMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function readWithin(io: OpeningCostIo, deadlineMs: number): Promise<CostState | null> {
  try {
    return await withDeadline((signal) => io.readState(signal), deadlineMs);
  } catch {
    return null;
  }
}

// The single place a setup attempt is orchestrated. Never retries: the RPC is called at most once,
// and a timeout is resolved only by a read -- so a blind retry can never create a second audit row.
// Every request is bounded, so this always settles and the caller's button can never wait forever.
export async function runOpeningCostSetup(io: OpeningCostIo, unitCost: number): Promise<OpeningCostResult> {
  const deadlineMs = io.deadlineMs ?? OPENING_COST_REQUEST_DEADLINE_MS;
  const before = await readWithin(io, deadlineMs);
  if (!before) {
    return { status: "failed", message: "Could not read the current cost before setting it. Reload and try again." };
  }

  let outcome: RpcOutcome;
  try {
    outcome = await withDeadline((signal) => io.callRpc(before.averageUnitCost, signal), deadlineMs);
  } catch (thrown) {
    outcome = { error: { message: thrown instanceof Error ? thrown.message : "request failed" }, status: 0 };
  }

  if (!outcome.error) {
    return { status: "saved", unitCost, confirmedByReadBack: false };
  }
  if (!isUncertainTransportFailure(outcome)) {
    return { status: "failed", message: `Could not set opening cost: ${describeIngredientConstraintError({ code: outcome.error.code ?? "", message: outcome.error.message })}` };
  }

  io.onCheckingResult?.();
  const after = await readWithin(io, deadlineMs);
  if (!after) {
    return { status: "uncertain", message: UNCERTAIN_UNREADABLE_MESSAGE };
  }
  const verdict = classifyCostReadBack(before, after, unitCost);
  if (verdict === "committed") {
    return { status: "saved", unitCost, confirmedByReadBack: true };
  }
  return { status: "uncertain", message: verdict === "unchanged" ? TIMEOUT_NOT_SAVED_MESSAGE : CHANGED_DURING_TIMEOUT_MESSAGE };
}

export const CHECKING_RESULT_MESSAGE = "The result is uncertain because the request timed out. Reloading the Item to check whether it was saved...";

export function openingCostSavedMessage(unitCost: number, baseUnit: string): string {
  return `Opening cost set at ${formatPesosPerUnit(unitCost, baseUnit)}.`;
}
