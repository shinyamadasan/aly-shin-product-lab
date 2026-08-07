import { useEffect } from "react";

// Owns exactly two things that both react to the same `isDirty` boolean changing: registering the
// browser's native beforeunload prompt, and telling whichever ancestor owns the app's navigation
// guard (ProductLab, via AppShell) that Costing currently has unsaved changes. Computing `isDirty`
// itself is the caller's job (CostingForm, via costing-form-snapshot.ts's pure comparison) -- this
// hook has no opinion on what "dirty" means, only on what to do once it's known.
//
// Modern browsers ignore any custom beforeunload message and show their own fixed text -- setting
// `event.returnValue` is still required to trigger the native prompt at all in some browsers, even
// though its *value* no longer controls what's displayed, so it's set to a fixed placeholder, never
// meant to be read.
export function useUnsavedCostingChanges(isDirty: boolean, onDirtyChange?: (isDirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!isDirty) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "unsaved-changes";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);
}
