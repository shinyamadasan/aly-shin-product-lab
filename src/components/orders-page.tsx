"use client";

// Orders: the first usable Selling workflow.
//
// Scope is S2 exactly -- select or create a customer, build an order from the sellable menu or
// custom items, save it atomically, and see it again after a reload. There are deliberately NO
// status or payment actions here (Confirm / Ready / Complete / Cancel / Mark paid / Refund):
// those are S3 and S4, and adding a button early would mean shipping a state machine with no way
// to record the money that goes with it.
//
// Data access goes through src/lib/orders-repository.ts. Orders never enter LabState. The catalog
// (products, batches, costings, selling formats) is read from LabState because it is already
// loaded there; nothing about orders is written back into it.

import { ClipboardList, PackagePlus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, MessageBox, Panel, SecondaryButton, Tag } from "@/components/ui";
import { createMutationGuard } from "@/lib/mutation-guard";
import { buildLinesFromDrafts, CUSTOM_ITEM_KEY, findSellableItem, getSellableItems, type DraftLine, type SellableProductGroup } from "@/lib/orders/menu";
import { getOrderTotals } from "@/lib/orders/totals";
import { validateCustomerForSave, validateOrderForSave } from "@/lib/orders/validation";
import { ORDER_SOURCES, type Customer, type Order, type OrderLine, type OrderSource } from "@/lib/orders/types";
import { listCustomers, listOrderLines, listOrders, saveCustomer, saveOrder, type OrdersClient } from "@/lib/orders-repository";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import type { LabState } from "@/lib/lab-state";
import { supabase } from "@/lib/supabase";

export const UNSAVED_ORDER_MESSAGE = "You have unsaved changes in this order. Leaving now will discard them. Continue?";

function newDraftLine(): DraftLine {
  return { rowId: crypto.randomUUID(), itemKey: "", itemName: "", unitPrice: "", quantity: "1" };
}

function formatPeso(value: number): string {
  return `₱${value.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatWhen(value: string | null): string {
  if (!value) return "Not scheduled";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function sourceLabel(source: OrderSource): string {
  return source === "unknown" ? "Unknown source" : source.replace(/_/g, " ");
}

export function OrdersPage({ labState, onDirtyChange }: { labState: LabState; onDirtyChange: (isDirty: boolean) => void }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [linesByOrderId, setLinesByOrderId] = useState<Map<string, OrderLine[]>>(new Map());
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [loadFailure, setLoadFailure] = useState<{ reason: "missing-table" | "failed"; message: string } | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"good" | "bad" | "info">("info");
  const [isCreating, setIsCreating] = useState(false);

  // Form state.
  const [customerId, setCustomerId] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [draftLines, setDraftLines] = useState<DraftLine[]>([newDraftLine()]);
  const [fulfillmentMethod, setFulfillmentMethod] = useState<"pickup" | "delivery">("pickup");
  const [fulfillmentAt, setFulfillmentAt] = useState("");
  const [fulfillmentAddress, setFulfillmentAddress] = useState("");
  const [source, setSource] = useState<OrderSource>("unknown");
  const [notes, setNotes] = useState("");

  // Minted once per form, not per submit: a double-click upserts the same row rather than
  // inserting two orders. Same discipline as resolveCostingId.
  const orderIdRef = useRef<string>(crypto.randomUUID());
  const guardRef = useRef(createMutationGuard<string>());

  const client = supabase as unknown as OrdersClient | null;

  const sellableGroups: SellableProductGroup[] = useMemo(
    () => getSellableItems(labState.products, labState.batches, labState.costings, labState.sellingFormats),
    [labState.products, labState.batches, labState.costings, labState.sellingFormats],
  );

  // Reloading is driven by a token rather than by calling a fetch function directly, matching
  // opportunities-page.tsx: the async work is declared inside the effect with a `cancelled` flag,
  // so a response arriving after unmount (or after a newer reload started) is discarded instead of
  // writing into a stale component.
  useEffect(() => {
    let cancelled = false;

    async function loadAll() {
      // "No Supabase configured" is a static fact about the environment, not loaded state, so it
      // is handled as a render condition below rather than stored.
      if (!client) {
        return;
      }

      const orderResult = await listOrders(client);
      if (cancelled) return;
      if (!orderResult.ok) {
        setLoadFailure({ reason: orderResult.reason, message: orderResult.message });
        setIsLoading(false);
        return;
      }

      const lineResult = await listOrderLines(client, orderResult.orders.map((order) => order.id));
      if (cancelled) return;
      if (!lineResult.ok) {
        setLoadFailure({ reason: lineResult.reason, message: lineResult.message });
        setIsLoading(false);
        return;
      }

      const customerResult = await listCustomers(client);
      if (cancelled) return;
      if (!customerResult.ok) {
        setLoadFailure({ reason: customerResult.reason, message: customerResult.message });
        setIsLoading(false);
        return;
      }

      setLoadFailure(null);
      setOrders(orderResult.orders);
      setLinesByOrderId(lineResult.linesByOrderId);
      setCustomers(customerResult.customers);
      setIsLoading(false);
    }

    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [client, reloadToken]);

  const reload = useCallback(() => {
    setIsLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  const isDirty = isCreating && (customerId !== "" || newCustomerName.trim() !== "" || draftLines.some((line) => line.itemKey !== "" || line.itemName.trim() !== ""));
  // The app's existing guard, not a second one: it reports upward to ProductLab/AppShell and
  // registers the native beforeunload prompt. Orders is its fourth consumer.
  useUnsavedChangesGuard(isDirty, onDirtyChange);

  // The running total is a function of prices and quantities only, so the preview lines are built
  // against a placeholder id -- the real order id is applied when the order is actually saved.
  // Keeping it out of render also means the id ref is never read during render.
  const previewLines = useMemo(() => buildLinesFromDrafts(draftLines, sellableGroups, "preview"), [draftLines, sellableGroups]);
  const previewTotal = getOrderTotals(previewLines).total;

  function resetForm() {
    orderIdRef.current = crypto.randomUUID();
    setCustomerId("");
    setNewCustomerName("");
    setDraftLines([newDraftLine()]);
    setFulfillmentMethod("pickup");
    setFulfillmentAt("");
    setFulfillmentAddress("");
    setSource("unknown");
    setNotes("");
  }

  async function handleSave() {
    if (!client) return;

    const orderId = orderIdRef.current;
    // Synchronous check-and-set before anything async, because a state-only guard misses a true
    // double-click -- the lesson bake-page.tsx learned the hard way.
    if (guardRef.current.isActive(orderId)) return;

    await guardRef.current.run(orderId, async () => {
      const now = new Date().toISOString();

      let resolvedCustomerId = customerId;
      if (!resolvedCustomerId) {
        const nameError = validateCustomerForSave(newCustomerName);
        if (nameError) {
          setMessage(nameError);
          setMessageTone("bad");
          return;
        }

        const customer: Customer = {
          id: crypto.randomUUID(),
          name: newCustomerName.trim(),
          phone: "",
          messagingHandle: "",
          email: "",
          notes: "",
          createdAt: now,
          updatedAt: now,
        };
        const customerResult = await saveCustomer(client, customer, now);
        if (!customerResult.ok) {
          setMessage(customerResult.message);
          setMessageTone("bad");
          return;
        }
        resolvedCustomerId = customer.id;
      }

      const order: Order = {
        id: orderId,
        customerId: resolvedCustomerId,
        status: "new",
        paymentStatus: "unpaid",
        paymentMethod: null,
        paidAt: null,
        paidAmount: null,
        refundedAt: null,
        fulfillmentMethod,
        fulfillmentAt: fulfillmentAt ? new Date(fulfillmentAt).toISOString() : null,
        fulfillmentAddress: fulfillmentMethod === "delivery" ? fulfillmentAddress.trim() : "",
        fulfillmentNotes: "",
        source,
        sourceRef: "",
        // Written automatically, never offered as a choice: it describes how the record was typed
        // in, not where the customer came from.
        entryMethod: "manual",
        notes: notes.trim(),
        placedAt: now,
        completedAt: null,
        cancelledAt: null,
        cancelReason: "",
        createdAt: now,
        updatedAt: now,
      };

      const lines = buildLinesFromDrafts(draftLines, sellableGroups, orderId);
      const validationError = validateOrderForSave(order, lines);
      if (validationError) {
        setMessage(validationError);
        setMessageTone("bad");
        return;
      }

      const result = await saveOrder(client, { order, lines, removedLineIds: [], now });
      if (!result.ok) {
        setMessage(result.message);
        setMessageTone("bad");
        return;
      }

      setMessage(`Order saved for ${customers.find((entry) => entry.id === resolvedCustomerId)?.name ?? newCustomerName.trim()}.`);
      setMessageTone("good");
      setIsCreating(false);
      setSelectedOrderId(orderId);
      resetForm();
      reload();
    });
  }

  // Both of these are the established "this screen needs setup" degradation, not a crash -- the
  // same shape Content Studio and every other optional-table screen already uses.
  if (!client) {
    return (
      <Panel icon={<ClipboardList size={18} />} title="Orders needs Supabase">
        <p className="text-sm leading-6 text-[#5f4a3d]">Orders reads and writes through Supabase, which is not configured in this environment. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then reload this page.</p>
      </Panel>
    );
  }

  if (loadFailure?.reason === "missing-table") {
    return (
      <Panel icon={<ClipboardList size={18} />} title="Orders needs one-time setup">
        <p className="text-sm leading-6 text-[#5f4a3d]">{loadFailure.message}</p>
      </Panel>
    );
  }

  const selectedOrder = orders.find((order) => order.id === selectedOrderId) ?? null;
  const selectedLines = selectedOrder ? linesByOrderId.get(selectedOrder.id) ?? [] : [];

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_420px]" id="orders">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Orders</h3>
            <p className="text-sm text-[#6f5a4c]">{isLoading ? "Loading…" : `${orders.length} order${orders.length === 1 ? "" : "s"} recorded`}</p>
          </div>
          <div className="flex gap-2">
            <SecondaryButton onClick={reload}>
              <span className="inline-flex items-center gap-2"><RefreshCw size={14} /> Refresh</span>
            </SecondaryButton>
            <SecondaryButton onClick={() => { setIsCreating((value) => !value); setMessage(""); }}>{isCreating ? "Cancel new order" : "New order"}</SecondaryButton>
          </div>
        </div>

        {message ? <MessageBox message={message} tone={messageTone} /> : null}
        {loadFailure && loadFailure.reason === "failed" ? <MessageBox message={loadFailure.message} tone="bad" /> : null}

        {isCreating ? (
          <NewOrderForm
            customers={customers}
            customerId={customerId}
            draftLines={draftLines}
            fulfillmentAddress={fulfillmentAddress}
            fulfillmentAt={fulfillmentAt}
            fulfillmentMethod={fulfillmentMethod}
            newCustomerName={newCustomerName}
            notes={notes}
            onSave={() => void handleSave()}
            previewTotal={previewTotal}
            sellableGroups={sellableGroups}
            setCustomerId={setCustomerId}
            setDraftLines={setDraftLines}
            setFulfillmentAddress={setFulfillmentAddress}
            setFulfillmentAt={setFulfillmentAt}
            setFulfillmentMethod={setFulfillmentMethod}
            setNewCustomerName={setNewCustomerName}
            setNotes={setNotes}
            setSource={setSource}
            source={source}
          />
        ) : null}

        <div className="space-y-2">
          {!isLoading && orders.length === 0 ? <p className="rounded-lg border border-dashed border-[#d8c7b7] p-6 text-sm text-[#6f5a4c]">No orders recorded yet. Use “New order” to add the first one.</p> : null}
          {orders.map((order) => {
            const lines = linesByOrderId.get(order.id) ?? [];
            const total = getOrderTotals(lines).total;
            const customer = customers.find((entry) => entry.id === order.customerId);
            return (
              <button
                className={`w-full rounded-lg border p-4 text-left text-sm ${order.id === selectedOrderId ? "border-[#8f5632] bg-[#fffaf3]" : "border-[#e1d4c4] bg-white hover:bg-[#fffaf3]"}`}
                key={order.id}
                onClick={() => setSelectedOrderId(order.id)}
                type="button"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{customer?.name ?? "Unknown customer"}</span>
                  <span className="font-semibold">{formatPeso(total)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#6f5a4c]">
                  <Tag tone="warm">{order.status}</Tag>
                  <span>{order.fulfillmentMethod === "delivery" ? "Delivery" : "Pickup"}</span>
                  <span>· {formatWhen(order.fulfillmentAt)}</span>
                  <span>· {sourceLabel(order.source)}</span>
                </div>
                <p className="mt-1 text-xs text-[#6f5a4c]">{lines.length} item{lines.length === 1 ? "" : "s"}</p>
              </button>
            );
          })}
        </div>
      </div>

      <OrderDetailPanel customer={customers.find((entry) => entry.id === selectedOrder?.customerId) ?? null} lines={selectedLines} order={selectedOrder} />
    </section>
  );
}

function NewOrderForm({
  customers,
  customerId,
  draftLines,
  fulfillmentAddress,
  fulfillmentAt,
  fulfillmentMethod,
  newCustomerName,
  notes,
  onSave,
  previewTotal,
  sellableGroups,
  setCustomerId,
  setDraftLines,
  setFulfillmentAddress,
  setFulfillmentAt,
  setFulfillmentMethod,
  setNewCustomerName,
  setNotes,
  setSource,
  source,
}: {
  customers: Customer[];
  customerId: string;
  draftLines: DraftLine[];
  fulfillmentAddress: string;
  fulfillmentAt: string;
  fulfillmentMethod: "pickup" | "delivery";
  newCustomerName: string;
  notes: string;
  onSave: () => void;
  previewTotal: number;
  sellableGroups: SellableProductGroup[];
  setCustomerId: (value: string) => void;
  setDraftLines: (updater: (lines: DraftLine[]) => DraftLine[]) => void;
  setFulfillmentAddress: (value: string) => void;
  setFulfillmentAt: (value: string) => void;
  setFulfillmentMethod: (value: "pickup" | "delivery") => void;
  setNewCustomerName: (value: string) => void;
  setNotes: (value: string) => void;
  setSource: (value: OrderSource) => void;
  source: OrderSource;
}) {
  function updateLine(rowId: string, patch: Partial<DraftLine>) {
    setDraftLines((lines) => lines.map((line) => (line.rowId === rowId ? { ...line, ...patch } : line)));
  }

  return (
    <form
      className="grid gap-4 rounded-lg border border-[#e1d4c4] bg-white p-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[#9a5b2f]"><PackagePlus size={18} /></span>
        <h3 className="text-lg font-semibold">New order</h3>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">
          Customer
          <select autoFocus className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" onChange={(event) => setCustomerId(event.target.value)} value={customerId}>
            <option value="">+ New customer…</option>
            {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
          </select>
        </label>
        {customerId === "" ? (
          <label className="grid gap-1 text-sm font-medium">
            New customer name
            <input className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" onChange={(event) => setNewCustomerName(event.target.value)} placeholder="Maria Santos" value={newCustomerName} />
          </label>
        ) : null}
      </div>

      <div className="grid gap-2">
        <p className="text-sm font-semibold">Items</p>
        {draftLines.map((line) => {
          const item = line.itemKey && line.itemKey !== CUSTOM_ITEM_KEY ? findSellableItem(sellableGroups, line.itemKey) : null;
          return (
            <div className="grid gap-2 rounded-md border border-[#e8dccd] p-3 sm:grid-cols-[minmax(0,2fr)_90px_110px_auto]" key={line.rowId}>
              <label className="grid gap-1 text-xs font-medium">
                Item
                <select
                  className="h-10 min-w-0 rounded-md border border-[#d8c7b7] bg-white px-2"
                  onChange={(event) => {
                    const nextKey = event.target.value;
                    const picked = findSellableItem(sellableGroups, nextKey);
                    updateLine(line.rowId, {
                      itemKey: nextKey,
                      itemName: picked ? picked.itemName : nextKey === CUSTOM_ITEM_KEY ? line.itemName : "",
                      // Pre-filled from the format, and editable afterwards.
                      unitPrice: picked ? String(picked.unitPrice) : line.unitPrice,
                    });
                  }}
                  value={line.itemKey}
                >
                  <option value="">Choose an item…</option>
                  {sellableGroups.map((group) => (
                    <optgroup key={group.productId} label={group.productName}>
                      {group.items.map((option) => <option key={option.key} value={option.key}>{option.formatName}</option>)}
                    </optgroup>
                  ))}
                  <option value={CUSTOM_ITEM_KEY}>Custom item…</option>
                </select>
              </label>

              <label className="grid gap-1 text-xs font-medium">
                Qty
                {/* Integer stepper: bakery selling units are discrete, so 2.5 boxes is not enterable. */}
                <input className="h-10 min-w-0 rounded-md border border-[#d8c7b7] bg-white px-2" min={1} onChange={(event) => updateLine(line.rowId, { quantity: event.target.value })} step={1} type="number" value={line.quantity} />
              </label>

              <label className="grid gap-1 text-xs font-medium">
                Unit price
                <input className="h-10 min-w-0 rounded-md border border-[#d8c7b7] bg-white px-2" min={0} onChange={(event) => updateLine(line.rowId, { unitPrice: event.target.value })} step="0.01" type="number" value={line.unitPrice} />
              </label>

              <div className="flex items-end">
                <SecondaryButton disabled={draftLines.length === 1} onClick={() => setDraftLines((lines) => lines.filter((entry) => entry.rowId !== line.rowId))}>Remove</SecondaryButton>
              </div>

              {line.itemKey === CUSTOM_ITEM_KEY ? (
                <label className="grid gap-1 text-xs font-medium sm:col-span-4">
                  Custom item name
                  <input className="h-10 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => updateLine(line.rowId, { itemName: event.target.value })} placeholder="Delivery fee" value={line.itemName} />
                </label>
              ) : null}

              {item ? (
                // Read-only: the pack size comes from the format and is never typed. It is
                // snapshotted onto the line so it survives the format being deleted later.
                <p className="text-xs text-[#6f5a4c] sm:col-span-4">{item.piecesPerUnit} pieces per unit · snapshotted with this line</p>
              ) : null}
            </div>
          );
        })}
        <div>
          <SecondaryButton onClick={() => setDraftLines((lines) => [...lines, newDraftLine()])}>Add item</SecondaryButton>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">
          Fulfilment
          <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" onChange={(event) => setFulfillmentMethod(event.target.value as "pickup" | "delivery")} value={fulfillmentMethod}>
            <option value="pickup">Pickup</option>
            <option value="delivery">Delivery</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          When <span className="text-xs font-normal text-[#6f5a4c]">(optional)</span>
          <input className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" onChange={(event) => setFulfillmentAt(event.target.value)} type="datetime-local" value={fulfillmentAt} />
        </label>
        {fulfillmentMethod === "delivery" ? (
          <label className="grid gap-1 text-sm font-medium sm:col-span-2">
            Delivery address
            <input className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" onChange={(event) => setFulfillmentAddress(event.target.value)} value={fulfillmentAddress} />
          </label>
        ) : null}
        <label className="grid gap-1 text-sm font-medium">
          Where did this order come from?
          <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" onChange={(event) => setSource(event.target.value as OrderSource)} value={source}>
            {ORDER_SOURCES.map((option) => <option key={option} value={option}>{option === "unknown" ? "Unknown" : option}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium sm:col-span-2">
          Notes
          <textarea className="min-h-16 rounded-md border border-[#d8c7b7] bg-white p-3" onChange={(event) => setNotes(event.target.value)} value={notes} />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e8dccd] pt-3">
        {/* Live from getOrderTotals -- no calculate button, and never stored. */}
        <p className="text-sm">Total <span className="text-lg font-semibold">{formatPeso(previewTotal)}</span></p>
        <Button>Place order</Button>
      </div>
    </form>
  );
}

function OrderDetailPanel({ customer, lines, order }: { customer: Customer | null; lines: OrderLine[]; order: Order | null }) {
  if (!order) {
    return (
      <Panel icon={<ClipboardList size={18} />} title="Order detail">
        <p className="text-sm leading-6 text-[#5f4a3d]">Select an order to see its items.</p>
      </Panel>
    );
  }

  const totals = getOrderTotals(lines);

  return (
    <Panel icon={<ClipboardList size={18} />} title={customer?.name ?? "Order"}>
      <div className="space-y-3 text-sm text-[#5f4a3d]">
        <div className="flex flex-wrap gap-2 text-xs">
          <Tag tone="warm">{order.status}</Tag>
          <Tag tone={order.paymentStatus === "paid" ? "green" : "warm"}>{order.paymentStatus}</Tag>
          <Tag tone="warm">{sourceLabel(order.source)}</Tag>
        </div>
        <p className="text-xs">{order.fulfillmentMethod === "delivery" ? "Delivery" : "Pickup"} · {formatWhen(order.fulfillmentAt)}</p>
        {order.fulfillmentAddress ? <p className="text-xs">{order.fulfillmentAddress}</p> : null}

        <div className="divide-y divide-[#f0e6da] border-y border-[#f0e6da]">
          {lines.map((line) => (
            <div className="flex items-start justify-between gap-3 py-2" key={line.id}>
              <div>
                <p className="font-medium">{line.itemName}</p>
                <p className="text-xs text-[#6f5a4c]">
                  ×{line.quantity} @ {formatPeso(line.unitPrice)}
                  {line.piecesPerUnitSnapshot === null ? " · pieces not recorded" : ` · ${line.piecesPerUnitSnapshot} pcs/unit · ${line.quantity * line.piecesPerUnitSnapshot} pieces`}
                </p>
              </div>
              <p className="whitespace-nowrap font-semibold">{formatPeso(line.unitPrice * line.quantity)}</p>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <span className="font-semibold">Current total</span>
          <span className="text-lg font-semibold">{formatPeso(totals.total)}</span>
        </div>
        {order.notes ? <p className="text-xs">{order.notes}</p> : null}
      </div>
    </Panel>
  );
}
