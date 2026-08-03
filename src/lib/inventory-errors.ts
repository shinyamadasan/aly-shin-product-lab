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
