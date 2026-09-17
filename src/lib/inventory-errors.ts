import type { PostgrestError } from "@supabase/supabase-js";

// The ingredients_base_unit_check CHECK constraint (supabase-migrate-canonical-base-units.sql,
// NOT VALID) is re-validated by Postgres against the WHOLE row on every UPDATE, not only when
// base_unit itself changes -- so any ingredient left with a legacy/flagged base_unit can fail a
// purchase, bake, adjustment, or plain edit that never touched base_unit at all. Postgres reports
// this as a check_violation (SQLSTATE 23514) naming the constraint; matched by code, not text, the
// same convention this file's isMissingColumnError/isMissingTableError already use, since
// Postgres/PostgREST error text isn't a stable contract to match against.
const BASE_UNIT_CHECK_CONSTRAINT_NAME = "ingredients_base_unit_check";
const CHECK_VIOLATION_CODE = "23514";

export function isBaseUnitConstraintError(error: Pick<PostgrestError, "code" | "message"> | null | undefined): boolean {
  return Boolean(error) && error!.code === CHECK_VIOLATION_CODE && error!.message.includes(BASE_UNIT_CHECK_CONSTRAINT_NAME);
}

// Rewrites that one specific, recognized constraint violation into an actionable message; any
// other error (including a different check_violation) is returned unchanged -- this never masks
// or reinterprets an unrelated failure.
export function describeIngredientConstraintError(error: Pick<PostgrestError, "code" | "message">): string {
  if (isBaseUnitConstraintError(error)) {
    return "This Item's canonical unit was flagged during the unit-normalization migration and hasn't been reconciled yet, so it can't be saved. Review it under \"Needs manual reconciliation\" on the Items page, correct its unit and quantity by hand, then ask an operator to clear the flag.";
  }
  return error.message;
}

// hard_delete_ingredient_if_unreferenced (supabase/migrations/20260917175753_ingredient_hard_
// delete_guard.sql) independently re-checks every reference category the client-side guard already
// checked, inside the same transaction as the delete -- this is the message shown when that
// server-side re-check finds a reference the client's own check missed (something else wrote a new
// reference between the client's check and this call). Matched by text, same convention as
// isBaseUnitConstraintError, since Postgres/PostgREST error text isn't a stable contract to match
// against a custom code.
const HARD_DELETE_BLOCKED_PHRASE = "cannot be permanently deleted";

export function isHardDeleteBlockedError(error: Pick<PostgrestError, "code" | "message"> | null | undefined): boolean {
  return Boolean(error) && error!.message.includes(HARD_DELETE_BLOCKED_PHRASE);
}

// The same function's legacy-cutoff gate (ingredient_hard_delete_policy) also raises a message
// containing HARD_DELETE_BLOCKED_PHRASE, so this MORE specific phrase must be checked first --
// otherwise a legacy-blocked Item would incorrectly get the "became referenced" race-condition
// message below instead of the real reason.
const LEGACY_INGREDIENT_BLOCKED_PHRASE = "created before rename-history protection was active";

export function isLegacyIngredientBlockedError(error: Pick<PostgrestError, "code" | "message"> | null | undefined): boolean {
  return Boolean(error) && error!.message.includes(LEGACY_INGREDIENT_BLOCKED_PHRASE);
}

export function describeHardDeleteError(ingredientName: string, error: Pick<PostgrestError, "code" | "message">): string {
  if (isLegacyIngredientBlockedError(error)) {
    return `${ingredientName} was created before rename-history protection existed, so its usage under any earlier name can't be verified. It can only be archived, not permanently deleted.`;
  }
  if (isHardDeleteBlockedError(error)) {
    return `${ingredientName} became referenced before the delete completed, so it was not deleted. Refresh and try again, or Archive it instead.`;
  }
  return describeIngredientConstraintError(error);
}
