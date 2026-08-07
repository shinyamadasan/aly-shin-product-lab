// Pure decision logic for InventoryWorkspace's tab-switch guards (both the outer
// stock/purchases/need-to-buy/history/ingredients tabs, and the inner Log-a-purchase/Import-CSV
// sub-tabs) -- extracted specifically to fix a stale-owner bug in how ProductLab's shared
// activeUnsavedForm gets cleared.
//
// Record-switching guards (editIngredientWithGuard, editSupplyWithGuard, editBatchWithGuard) never
// have this problem: a confirmed switch always remounts a fresh, clean replacement of the *same*
// component (via its key), and that fresh instance's own mount-time effect immediately reports
// isDirty=false, overwriting whatever stale "true" the discarded instance left behind.
//
// Tab-switching is different: confirming a switch away from a dirty tab unmounts that tab's editor
// with no replacement of the same type ever mounting to report false again. Without an explicit
// clear, ProductLab's activeUnsavedForm (and this workspace's own local isXDirty flag) would stay
// stuck on the discarded editor's message indefinitely -- causing AppShell's nav guard to keep
// prompting with a stale message even after the operator already confirmed leaving it.
//
// This function decides *whether to proceed* and *whether the leaving tab's dirty owner should be
// cleared* -- the caller performs the actual confirm() call, setTab()/setPurchasesTab(), and the
// dirty-state-clearing side effect. Generic over the tab type so the same logic serves both the
// outer InventoryTab switch and the inner "manual" | "csv" switch without duplicating it.
export type TabDirtyEntry = { isDirty: boolean; message: string };

export function resolveTabChange<Tab extends string>(
  currentTab: Tab,
  nextTab: Tab,
  leavingTabDirtyState: TabDirtyEntry | null,
  confirmDiscard: (message: string) => boolean,
): { proceed: boolean; shouldClearDirty: boolean } {
  if (nextTab === currentTab) {
    return { proceed: false, shouldClearDirty: false };
  }
  if (leavingTabDirtyState?.isDirty) {
    if (!confirmDiscard(leavingTabDirtyState.message)) {
      return { proceed: false, shouldClearDirty: false };
    }
    return { proceed: true, shouldClearDirty: true };
  }
  return { proceed: true, shouldClearDirty: false };
}
