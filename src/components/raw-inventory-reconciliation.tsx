"use client";

import { useRef, useState } from "react";
import type { LabState } from "@/lib/lab-state";
import { latestInventoryMovement } from "@/lib/raw-inventory-authority";

export function RawInventoryReconciliation({ labState, reconcile }: {
  labState: LabState;
  reconcile: (ingredientId: string, quantity: number, note: string) => Promise<boolean>;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const ingredient = labState.ingredients.find((item) => item.id === selectedId);
  const latest = ingredient ? latestInventoryMovement(ingredient.id, labState.inventoryTransactions) : undefined;

  async function submit(form: FormData) {
    if (guard.current || !ingredient) return;
    const raw = String(form.get("quantity") ?? "").trim();
    const note = String(form.get("note") ?? "").trim();
    if (!raw || !Number.isFinite(Number(raw)) || Number(raw) < 0 || !note || form.get("verified") !== "on") return;
    guard.current = true;
    setBusy(true);
    try {
      if (await reconcile(ingredient.id, Number(raw), note)) setSelectedId("");
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }

  return (
    // Starts hidden -- the component stays mounted (its state/behavior is unchanged), but it no
    // longer shows as a large standalone bar above the Inventory tabs during normal use. Only the
    // Stock tab's "Count / correct stock" action (InventoryWorkspace's goToStockCount) removes
    // this "hidden" class, via the same DOM-id lookup it already uses to open and scroll to
    // #raw-inventory-reconciliation below -- no duplicate form, no changed reconciliation logic.
    <div className="hidden" id="raw-inventory-reconciliation-wrapper">
      <details className="rounded-md border border-[#d8c7b7] bg-white p-4" id="raw-inventory-reconciliation">
        <summary className="cursor-pointer font-semibold">Verify physical stock / correct a count</summary>
        <p className="my-3 text-sm">Count the ingredient first. Recorded balances are references, not verified physical quantities. Earlier history stays unchanged.</p>
        <label className="grid gap-1">
          Ingredient
          <select className="h-11 rounded border px-3 text-base" disabled={busy} onChange={(event) => setSelectedId(event.target.value)} value={selectedId}>
            <option value="">Choose an ingredient</option>
            {labState.ingredients.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.inventoryReconciledAt ? "count recorded" : "needs opening count"}</option>)}
          </select>
        </label>
        {ingredient ? (
          <form action={submit} className="mt-3 grid gap-3" key={ingredient.id}>
            <p className="text-sm">Recorded current: {ingredient.currentQuantity} {ingredient.baseUnit}. Latest ledger: {latest ? `${latest.quantityAfter} ${ingredient.baseUnit}` : "no movement recorded"}.</p>
            <p className="text-sm">{ingredient.inventoryReconciledAt ? `Last verified count: ${ingredient.inventoryReconciledAt}` : "No verified opening count recorded."} This count does not verify or change the recorded average cost.</p>
            <label className="grid gap-1">Verified physical quantity ({ingredient.baseUnit})<input className="h-11 rounded border px-3 text-base" disabled={busy} min="0" name="quantity" required step="any" type="number" /></label>
            <label className="grid gap-1">Count note<input className="h-11 rounded border px-3 text-base" disabled={busy} name="note" placeholder="When and how you counted" required /></label>
            <label className="flex gap-2"><input disabled={busy} name="verified" required type="checkbox" />I physically verified this quantity.</label>
            <button className="h-11 rounded border px-4 font-semibold disabled:opacity-50" disabled={busy} type="submit">{busy ? "Recording…" : "Record verified count"}</button>
          </form>
        ) : null}
      </details>
    </div>
  );
}
