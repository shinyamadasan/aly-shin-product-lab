"use client";

// Orders: the first usable Selling workflow.
//
// Scope is S2 + S3 + S4 + S5 + S6, which is the whole approved MVP: create an order, move it
// through its lifecycle, record payment against it, correct the agreed handover facts, and correct
// where it came from. Order LINES are still not editable after creation -- that is deliberate and
// unchanged, and everything downstream of it (see updatePaymentStatus's caller-supplied lines)
// depends on it staying that way.
//
// Nothing here belongs to S7+: no dashboard, no readout, no public ordering surface.
//
// Data access goes through src/lib/orders-repository.ts. Orders never enter LabState. The catalog
// (products, batches, costings, selling formats) is read from LabState because it is already
// loaded there; nothing about orders is written back into it.

import { ClipboardList, PackagePlus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, MessageBox, Panel, SecondaryButton, Tag } from "@/components/ui";
import { createMutationGuard } from "@/lib/mutation-guard";
import { getOrderCountsBySource } from "@/lib/orders/attribution";
import { toDisplayPrice } from "@/lib/orders/money";
import { filterOrdersByFulfillment, FULFILLMENT_FILTERS, FULFILLMENT_SORTS, getActiveDeliveryAddress, sortOrdersByFulfillment, type FulfillmentFilter, type FulfillmentSort } from "@/lib/orders/fulfillment";
import { buildLinesFromDrafts, CUSTOM_ITEM_KEY, findSellableItem, getSellableItems, type DraftLine, type SellableProductGroup } from "@/lib/orders/menu";
import { getOrderTotals, getPaymentDivergence } from "@/lib/orders/totals";
import { getAllowedOrderTransitions, isValidOrderTransition } from "@/lib/orders/transitions";
import { findPossibleDuplicateCustomer } from "@/lib/orders/validation";
import { isPaymentMethod, ORDER_SOURCES, PAYMENT_METHODS, type Customer, type FulfillmentMethod, type Order, type OrderLine, type OrderSource, type OrderStatus, type PaymentMethod } from "@/lib/orders/types";
import { listCustomers, listOrderLines, listOrders, submitNewOrder, updateOrderAttribution, updateOrderFulfillment, updateOrderStatus, updatePaymentStatus, type OrdersClient, type PaymentAction } from "@/lib/orders-repository";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import type { LabState } from "@/lib/lab-state";
import { supabase } from "@/lib/supabase";

const PAID_CANCEL_PROMPT =
  "This order was paid \u2014 record a refund?\n\n" +
  "OK cancels the order and leaves it paid. Use Refund afterwards to record the money going back; cancelling alone never changes what was received.";

export const UNSAVED_ORDER_MESSAGE = "You have unsaved changes in this order. Leaving now will discard them. Continue?";

// Aly & Pon bakes and hands over in Manila. "Today" has to mean today HERE -- under UTC the
// business day rolls over at 08:00 local, so the first eight hours of every working day would be
// filed under yesterday. Resolved through src/lib/business-day.ts, the app's one business-day
// utility; no second one is introduced.
const BUSINESS_TIMEZONE = "Asia/Manila";

const FILTER_LABELS: Record<FulfillmentFilter, string> = {
  all: "All orders",
  today: "Handover today",
  unscheduled: "Not scheduled",
};

const SORT_LABELS: Record<FulfillmentSort, string> = {
  placed: "Newest first",
  soonest: "Handover soonest",
};

function newDraftLine(): DraftLine {
  return { rowId: crypto.randomUUID(), itemKey: "", itemName: "", unitPrice: "", quantity: "1" };
}

// Delegates to the shared rule so there is exactly one definition of what a price looks like --
// the same one the public price-consent check compares against.
function formatPeso(value: number): string {
  return `₱${toDisplayPrice(value)}`;
}

function formatWhen(value: string | null): string {
  if (!value) return "Not scheduled";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

// A datetime-local field yields a local "YYYY-MM-DDTHH:mm" or "". Empty means "not scheduled yet",
// which is a real state and stays null rather than becoming an invented time.
function toIsoInstant(localValue: string): string | null {
  if (!localValue) return null;
  const parsed = new Date(localValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

  // S5 list controls. Client-side over the orders already loaded -- no extra round trip, and the
  // defaults ("all", newest first) leave the list exactly as S2 shipped it.
  const [fulfillmentFilter, setFulfillmentFilter] = useState<FulfillmentFilter>("all");
  const [fulfillmentSort, setFulfillmentSort] = useState<FulfillmentSort>("placed");
  // The instant this list was read, stamped by the loader below rather than by render. "Handover
  // today" has to resolve against a clock, and reading one during render is impure -- so the clock
  // is read once, where the data is, and Refresh re-stamps it.
  const [loadedAtMs, setLoadedAtMs] = useState(0);

  // Form state.
  const [customerId, setCustomerId] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [draftLines, setDraftLines] = useState<DraftLine[]>([newDraftLine()]);
  const [fulfillmentMethod, setFulfillmentMethod] = useState<"pickup" | "delivery">("pickup");
  const [fulfillmentAt, setFulfillmentAt] = useState("");
  const [fulfillmentAddress, setFulfillmentAddress] = useState("");
  const [source, setSource] = useState<OrderSource>("unknown");
  const [notes, setNotes] = useState("");

  // Both minted once per form, not per submit. The order id makes a double-click upsert the same
  // row; the pending customer id makes a RETRY AFTER A FAILED SAVE upsert the same customer instead
  // of creating another one. Same discipline as resolveCostingId.
  const orderIdRef = useRef<string>(crypto.randomUUID());
  const pendingCustomerIdRef = useRef<string>(crypto.randomUUID());
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
      setLoadedAtMs(Date.now());
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

  // Lifecycle and payment actions. Each one re-reads the persisted order inside the repository
  // before deciding anything, so a button rendered against stale state cannot drive a transition
  // off a value that has since moved -- and the conditional update refuses to overwrite it anyway.
  const [actionBusy, setActionBusy] = useState(false);
  const actionGuardRef = useRef(createMutationGuard<string>());

  const runOrderAction = useCallback(
    async (orderId: string, action: () => Promise<{ ok: true; order: Order } | { ok: false; message: string }>) => {
      if (actionGuardRef.current.isActive(orderId)) {
        return;
      }

      await actionGuardRef.current.run(orderId, async () => {
        setActionBusy(true);
        try {
          const result = await action();
          if (!result.ok) {
            // Nothing optimistic was rendered, so a failed update leaves the displayed order
            // exactly as it was. Reloading also pulls in whatever it actually became.
            setMessage(result.message);
            setMessageTone("bad");
            reload();
            return;
          }

          setMessage("Order updated.");
          setMessageTone("good");
          reload();
        } finally {
          setActionBusy(false);
        }
      });
    },
    [reload],
  );

  // Every editable field on the new-order form counts, not just customer and lines: an operator who
  // has only set a delivery time or typed a note has still done work worth warning about.
  const isDirty =
    isCreating &&
    (customerId !== "" ||
      newCustomerName.trim() !== "" ||
      draftLines.some((line) => line.itemKey !== "" || line.itemName.trim() !== "") ||
      fulfillmentMethod !== "pickup" ||
      fulfillmentAt !== "" ||
      fulfillmentAddress.trim() !== "" ||
      source !== "unknown" ||
      notes.trim() !== "");
  // The app's existing guard, not a second one: it reports upward to ProductLab/AppShell and
  // registers the native beforeunload prompt. Orders is its fourth consumer.
  useUnsavedChangesGuard(isDirty, onDirtyChange);

  // A non-blocking hint, never a hard block: real people share names, so the operator may well be
  // creating a genuinely different Maria Santos. The candidate id is "" because no existing
  // customer can have an empty id, which keeps this from ever matching a row against itself --
  // and keeps the pending-id ref out of render.
  const possibleDuplicateCustomer = useMemo(
    () => (customerId === "" ? findPossibleDuplicateCustomer(customers, { id: "", name: newCustomerName }) : null),
    [customerId, customers, newCustomerName],
  );

  // The running total is a function of prices and quantities only, so the preview lines are built
  // against a placeholder id -- the real order id is applied when the order is actually saved.
  // Keeping it out of render also means the id ref is never read during render.
  const previewLines = useMemo(() => buildLinesFromDrafts(draftLines, sellableGroups, "preview"), [draftLines, sellableGroups]);
  const previewTotal = getOrderTotals(previewLines).total;

  // Filter first, then sort. Both are pure reads over the loaded list, and the clock they need is
  // the load stamp above rather than a fresh reading -- so this stays a pure render.
  const visibleOrders = useMemo(
    () => sortOrdersByFulfillment(filterOrdersByFulfillment(orders, fulfillmentFilter, { nowMs: loadedAtMs, timeZone: BUSINESS_TIMEZONE }), fulfillmentSort),
    [orders, fulfillmentFilter, fulfillmentSort, loadedAtMs],
  );

  // Counted over everything loaded, not over the current filter: this line answers "where do our
  // orders come from", which a fulfilment filter has no bearing on.
  const sourceCounts = useMemo(() => getOrderCountsBySource(orders), [orders]);

  function resetForm() {
    orderIdRef.current = crypto.randomUUID();
    pendingCustomerIdRef.current = crypto.randomUUID();
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

      // Resolved up front so the order can be built and validated before anything is written. When
      // a new customer is being created this is the form's STABLE pending id, so a retry after a
      // failed save upserts that same customer rather than adding a second one.
      const isCreatingCustomer = customerId === "";
      const resolvedCustomerId = isCreatingCustomer ? pendingCustomerIdRef.current : customerId;

      const newCustomer: Customer | null = isCreatingCustomer
        ? {
            id: resolvedCustomerId,
            name: newCustomerName.trim(),
            phone: "",
            messagingHandle: "",
            email: "",
            notes: "",
            createdAt: now,
            updatedAt: now,
          }
        : null;

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
        fulfillmentAt: toIsoInstant(fulfillmentAt),
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

      // One orchestration call: it validates everything BEFORE writing, so a rejected order never
      // leaves a customer row behind, then creates the customer (if needed) and saves the order.
      const result = await submitNewOrder(client, { order, lines, newCustomer, now });
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

  function runPaymentAction(action: PaymentAction) {
    if (!client || !selectedOrder) return;
    const id = selectedOrder.id;
    void runOrderAction(id, () => updatePaymentStatus(client, { orderId: id, action, now: new Date().toISOString() }));
  }

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_420px]" id="orders">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Orders</h3>
            <p className="text-sm text-[#6f5a4c]">{isLoading ? "Loading…" : visibleOrders.length === orders.length ? `${orders.length} order${orders.length === 1 ? "" : "s"} recorded` : `${visibleOrders.length} of ${orders.length} orders shown`}</p>
          </div>
          <div className="flex gap-2">
            <SecondaryButton onClick={reload}>
              <span className="inline-flex items-center gap-2"><RefreshCw size={14} /> Refresh</span>
            </SecondaryButton>
            <SecondaryButton onClick={() => { setIsCreating((value) => !value); setMessage(""); }}>{isCreating ? "Cancel new order" : "New order"}</SecondaryButton>
          </div>
        </div>

        {/* A cheap read, not a dashboard: one line of counts over the loaded orders. "Unknown" is
            shown rather than hidden, so the named channels are never made to look more complete
            than they are. */}
        {sourceCounts.length > 0 ? (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#6f5a4c]">
            {sourceCounts.map((entry) => (
              <span key={entry.source}>
                <span className="capitalize">{sourceLabel(entry.source)}</span> <span className="font-semibold">{entry.count}</span>
              </span>
            ))}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <label className="grid gap-1 text-xs font-medium">
            Show
            <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => setFulfillmentFilter(event.target.value as FulfillmentFilter)} value={fulfillmentFilter}>
              {FULFILLMENT_FILTERS.map((option) => <option key={option} value={option}>{FILTER_LABELS[option]}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Sort
            <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => setFulfillmentSort(event.target.value as FulfillmentSort)} value={fulfillmentSort}>
              {FULFILLMENT_SORTS.map((option) => <option key={option} value={option}>{SORT_LABELS[option]}</option>)}
            </select>
          </label>
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
            possibleDuplicateCustomer={possibleDuplicateCustomer}
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
          {!isLoading && orders.length > 0 && visibleOrders.length === 0 ? <p className="rounded-lg border border-dashed border-[#d8c7b7] p-6 text-sm text-[#6f5a4c]">No orders match “{FILTER_LABELS[fulfillmentFilter]}”. The other {orders.length} {orders.length === 1 ? "order is" : "orders are"} still here — switch back to “All orders”.</p> : null}
          {visibleOrders.map((order) => {
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

      <OrderDetailPanel
        actionBusy={actionBusy}
        customer={customers.find((entry) => entry.id === selectedOrder?.customerId) ?? null}
        lines={selectedLines}
        onCancel={(reason) => {
          if (!client || !selectedOrder) return;
          const id = selectedOrder.id;
          void runOrderAction(id, () => updateOrderStatus(client, { orderId: id, to: "cancelled", cancelReason: reason, now: new Date().toISOString() }));
        }}
        onClearPaymentRecord={() => runPaymentAction({ kind: "clear-record" })}
        onCorrectPaymentRecord={(correction) => runPaymentAction({ kind: "correct-record", ...correction })}
        onEditAttribution={(attribution) => {
          if (!client || !selectedOrder) return;
          const id = selectedOrder.id;
          void runOrderAction(id, () => updateOrderAttribution(client, { orderId: id, ...attribution, now: new Date().toISOString() }));
        }}
        onEditFulfillment={(fulfillment) => {
          if (!client || !selectedOrder) return;
          const id = selectedOrder.id;
          void runOrderAction(id, () => updateOrderFulfillment(client, { orderId: id, ...fulfillment, now: new Date().toISOString() }));
        }}
        onMarkPaid={(method) => runPaymentAction({ kind: "mark-paid", method, lines: selectedLines })}
        onRefund={() => runPaymentAction({ kind: "refund" })}
        onStatusChange={(to) => {
          if (!client || !selectedOrder) return;
          const id = selectedOrder.id;
          void runOrderAction(id, () => updateOrderStatus(client, { orderId: id, to, now: new Date().toISOString() }));
        }}
        order={selectedOrder}
      />
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
  possibleDuplicateCustomer,
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
  possibleDuplicateCustomer: { id: string; name: string } | null;
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
            {possibleDuplicateCustomer ? (
              // A hint, not a block. Saving anyway is a legitimate choice -- two people really can
              // share a name -- so this never disables the form.
              <span className="text-xs font-normal leading-5 text-[#9a5b2f]">
                &ldquo;{possibleDuplicateCustomer.name}&rdquo; already exists. Pick them from the list above if this is the same person, or carry on to create a second customer with this name.
              </span>
            ) : null}
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
                    // Switching a catalog pick to Custom must not leave the catalog's display name
                    // behind: a manual line called "Brownies - Box of 6" reads like a catalog sale
                    // while carrying no product, no format, and no pack size. Text already typed on
                    // an already-custom row is kept, since that is the operator's own.
                    const wasCatalogPick = line.itemKey !== "" && line.itemKey !== CUSTOM_ITEM_KEY;
                    updateLine(line.rowId, {
                      itemKey: nextKey,
                      itemName: picked ? picked.itemName : nextKey === CUSTOM_ITEM_KEY && !wasCatalogPick ? line.itemName : "",
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

function OrderDetailPanel({
  actionBusy,
  customer,
  lines,
  onCancel,
  onClearPaymentRecord,
  onCorrectPaymentRecord,
  onEditAttribution,
  onEditFulfillment,
  onMarkPaid,
  onRefund,
  onStatusChange,
  order,
}: {
  actionBusy: boolean;
  customer: Customer | null;
  lines: OrderLine[];
  onCancel: (reason: string) => void;
  onClearPaymentRecord: () => void;
  onCorrectPaymentRecord: (correction: { paidAmount: number; paidAt: string; method: PaymentMethod }) => void;
  // Both carry expectedUpdatedAt: the version of the order the edit form was populated from, so a
  // stale form is rejected by the conditional update rather than silently overwriting a newer row.
  onEditAttribution: (attribution: { expectedUpdatedAt: string; source: OrderSource; sourceRef: string }) => void;
  onEditFulfillment: (fulfillment: { expectedUpdatedAt: string; fulfillmentMethod: FulfillmentMethod; fulfillmentAt: string | null; fulfillmentAddress: string }) => void;
  onMarkPaid: (method: PaymentMethod) => void;
  onRefund: () => void;
  onStatusChange: (to: OrderStatus) => void;
  order: Order | null;
}) {
  const [isCorrecting, setIsCorrecting] = useState(false);
  const [isEditingFulfillment, setIsEditingFulfillment] = useState(false);
  const [isEditingAttribution, setIsEditingAttribution] = useState(false);

  if (!order) {
    return (
      <Panel icon={<ClipboardList size={18} />} title="Order detail">
        <p className="text-sm leading-6 text-[#5f4a3d]">Select an order to see its items.</p>
      </Panel>
    );
  }

  const totals = getOrderTotals(lines);
  const divergence = getPaymentDivergence(order, lines);
  const activeDeliveryAddress = getActiveDeliveryAddress(order);
  // The buttons come straight from the domain machine, so what the operator can click and what the
  // transition functions permit can never drift apart. A terminal order yields an empty list.
  const forwardTransitions = getAllowedOrderTransitions(order.status).filter((next) => next !== "cancelled");
  const canCancel = isValidOrderTransition(order.status, "cancelled");

  return (
    <Panel icon={<ClipboardList size={18} />} title={customer?.name ?? "Order"}>
      <div className="space-y-3 text-sm text-[#5f4a3d]">
        <div className="flex flex-wrap gap-2 text-xs">
          {/* Two tags, two state machines -- and there is no third. Fulfilment is an attribute of
              the order, reported on the line below, never a second status that could disagree. */}
          <Tag tone={order.status === "completed" ? "green" : order.status === "cancelled" ? "danger" : "warm"}>{order.status}</Tag>
          <Tag tone={order.paymentStatus === "paid" ? "green" : order.paymentStatus === "refunded" ? "danger" : "warm"}>{order.paymentStatus}</Tag>
        </div>
        <p className="text-xs">{order.fulfillmentMethod === "delivery" ? "Delivery" : "Pickup"} · {formatWhen(order.fulfillmentAt)}</p>
        {/* Asked for, never read straight off the row: under pickup a leftover delivery address is
            not active data and must not render as though it still applies. */}
        {activeDeliveryAddress ? <p className="text-xs">{activeDeliveryAddress}</p> : null}
        <p className="text-xs">{sourceLabel(order.source)}{order.sourceRef ? ` · ${order.sourceRef}` : ""}</p>

        <div className="flex flex-wrap gap-2">
          <SecondaryButton disabled={actionBusy} onClick={() => setIsEditingFulfillment((value) => !value)}>Edit schedule</SecondaryButton>
          <SecondaryButton disabled={actionBusy} onClick={() => setIsEditingAttribution((value) => !value)}>Edit source</SecondaryButton>
        </div>

        {isEditingFulfillment ? (
          <FulfillmentEditForm
            actionBusy={actionBusy}
            key={`fulfillment-${order.id}`}
            onSubmit={(fulfillment) => {
              setIsEditingFulfillment(false);
              onEditFulfillment(fulfillment);
            }}
            order={order}
          />
        ) : null}

        {isEditingAttribution ? (
          <AttributionEditForm
            actionBusy={actionBusy}
            key={`attribution-${order.id}`}
            onSubmit={(attribution) => {
              setIsEditingAttribution(false);
              onEditAttribution(attribution);
            }}
            order={order}
          />
        ) : null}

        {order.completedAt ? <p className="text-xs">Completed {formatWhen(order.completedAt)}</p> : null}
        {order.cancelledAt ? <p className="text-xs">Cancelled {formatWhen(order.cancelledAt)}{order.cancelReason ? ` — ${order.cancelReason}` : ""}</p> : null}

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

        {order.paidAmount !== null ? (
          <div className="flex items-center justify-between text-xs">
            <span>{order.paymentStatus === "refunded" ? "Refunded" : "Paid"} {formatWhen(order.paidAt)}{order.paymentMethod ? ` · ${order.paymentMethod.replace(/_/g, " ")}` : ""}</span>
            <span className="font-semibold">{formatPeso(order.paidAmount)}</span>
          </div>
        ) : null}
        {order.refundedAt ? <p className="text-xs">Refunded {formatWhen(order.refundedAt)}</p> : null}

        {divergence.state === "diverged" ? (
          // Informational only. A changed order total is NOT evidence that money moved, so there is
          // deliberately no "reconcile to current total" action anywhere on this panel.
          <div className="rounded-md bg-[#fff2d8] p-3 text-xs text-[#7a531d]">
            <p>Current total {formatPeso(divergence.currentTotal)} · paid {formatPeso(divergence.paidAmount)} · ⚠ {formatPeso(Math.abs(divergence.difference))} difference</p>
            <p className="mt-1 font-semibold">This does not change what was received.</p>
          </div>
        ) : null}

        {order.notes ? <p className="text-xs">{order.notes}</p> : null}

        <div className="flex flex-wrap gap-2 border-t border-[#e8dccd] pt-3">
          {forwardTransitions.map((next) => (
            <SecondaryButton disabled={actionBusy} key={next} onClick={() => onStatusChange(next)}>
              {next === "confirmed" ? "Confirm" : next === "ready" ? "Ready" : "Complete"}
            </SecondaryButton>
          ))}
          {order.paymentStatus === "unpaid" ? <SecondaryButton disabled={actionBusy} onClick={() => onMarkPaid(promptForMethod())}>Mark paid</SecondaryButton> : null}
          {order.paymentStatus === "paid" ? <SecondaryButton disabled={actionBusy} onClick={onRefund}>Refund</SecondaryButton> : null}
          {order.paymentStatus === "paid" ? <SecondaryButton disabled={actionBusy} onClick={() => setIsCorrecting((value) => !value)}>Correct payment record</SecondaryButton> : null}
          {canCancel ? (
            <SecondaryButton
              disabled={actionBusy}
              onClick={() => {
                // Cancelling never touches payment. If money was received it stays received until
                // the operator records an actual refund -- the prompt asks, it does not act.
                if (order.paymentStatus === "paid" && !window.confirm(PAID_CANCEL_PROMPT)) {
                  return;
                }
                onCancel(window.prompt("Why is this order cancelled? (optional)") ?? "");
              }}
            >
              Cancel order
            </SecondaryButton>
          ) : null}
        </div>

        {isCorrecting && order.paymentStatus === "paid" ? (
          <PaymentCorrectionForm
            actionBusy={actionBusy}
            onClear={() => {
              setIsCorrecting(false);
              onClearPaymentRecord();
            }}
            onSubmit={(correction) => {
              setIsCorrecting(false);
              onCorrectPaymentRecord(correction);
            }}
            order={order}
          />
        ) : null}
      </div>
    </Panel>
  );
}

function promptForMethod(): PaymentMethod {
  const raw = (window.prompt(`Payment method (${PAYMENT_METHODS.join(" / ")})`, "gcash") ?? "").trim().toLowerCase();
  return isPaymentMethod(raw) ? raw : "other";
}

// Pre-filled from the RECORDED payment, never from the current order total. Auto-filling from the
// total would quietly encode "the lines changed, therefore the payment changed", which is false.
function PaymentCorrectionForm({
  actionBusy,
  onClear,
  onSubmit,
  order,
}: {
  actionBusy: boolean;
  onClear: () => void;
  onSubmit: (correction: { paidAmount: number; paidAt: string; method: PaymentMethod }) => void;
  order: Order;
}) {
  const [amount, setAmount] = useState(order.paidAmount === null ? "" : String(order.paidAmount));
  const [paidAt, setPaidAt] = useState(toLocalDateTimeValue(order.paidAt));
  const [method, setMethod] = useState<PaymentMethod>(order.paymentMethod ?? "other");

  return (
    <form
      className="grid gap-2 rounded-md border border-[#e8dccd] p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ paidAmount: Number(amount), paidAt: paidAt ? new Date(paidAt).toISOString() : order.paidAt ?? "", method });
      }}
    >
      <p className="font-semibold">Correct payment record</p>
      <p className="leading-5">Use this only if the payment was recorded incorrectly. If the customer actually sent more money, that is a second payment — not supported yet.</p>
      <label className="grid gap-1 font-medium">
        Amount received
        <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" min={0} onChange={(event) => setAmount(event.target.value)} step="0.01" type="number" value={amount} />
      </label>
      <label className="grid gap-1 font-medium">
        Received on
        <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => setPaidAt(event.target.value)} type="datetime-local" value={paidAt} />
      </label>
      <label className="grid gap-1 font-medium">
        Method
        <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => setMethod(event.target.value as PaymentMethod)} value={method}>
          {PAYMENT_METHODS.map((option) => <option key={option} value={option}>{option.replace(/_/g, " ")}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button disabled={actionBusy}>Save correction</Button>
        <SecondaryButton disabled={actionBusy} onClick={onClear}>This payment never happened</SecondaryButton>
      </div>
    </form>
  );
}

// S5. Correcting the agreed handover facts after the order exists -- the plan is explicit that
// these are attributes, so this form edits fields and never moves the order through a state.
//
// The address input appears ONLY for delivery. Switching to pickup and saving clears the stored
// address rather than hiding it: an address on a pickup order is true of nothing, and a hidden one
// would resurface the moment someone switched back, silently claiming to be current.
function FulfillmentEditForm({
  actionBusy,
  onSubmit,
  order,
}: {
  actionBusy: boolean;
  onSubmit: (fulfillment: { expectedUpdatedAt: string; fulfillmentMethod: FulfillmentMethod; fulfillmentAt: string | null; fulfillmentAddress: string }) => void;
  order: Order;
}) {
  // Captured at mount, in the same breath as the values below. The version and the values MUST come
  // from one snapshot: reading order.updatedAt at submit time instead would let a background reload
  // refresh the version while these inputs still held the old values -- which is precisely the stale
  // write the version predicate exists to reject.
  const [renderedVersion] = useState(order.updatedAt);
  const [method, setMethod] = useState<FulfillmentMethod>(order.fulfillmentMethod);
  const [when, setWhen] = useState(toLocalDateTimeValue(order.fulfillmentAt));
  const [address, setAddress] = useState(order.fulfillmentAddress);

  return (
    <form
      className="grid gap-2 rounded-md border border-[#e8dccd] p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ expectedUpdatedAt: renderedVersion, fulfillmentMethod: method, fulfillmentAt: toIsoInstant(when), fulfillmentAddress: address });
      }}
    >
      <p className="font-semibold">Edit schedule</p>
      <label className="grid gap-1 font-medium">
        Fulfilment
        <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => setMethod(event.target.value as FulfillmentMethod)} value={method}>
          <option value="pickup">Pickup</option>
          <option value="delivery">Delivery</option>
        </select>
      </label>
      <label className="grid gap-1 font-medium">
        When <span className="font-normal text-[#6f5a4c]">(leave blank if not scheduled yet)</span>
        <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => setWhen(event.target.value)} type="datetime-local" value={when} />
      </label>
      {method === "delivery" ? (
        <label className="grid gap-1 font-medium">
          Delivery address
          <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => setAddress(event.target.value)} value={address} />
        </label>
      ) : (
        <p className="leading-5 text-[#6f5a4c]">Saving as pickup clears any delivery address on this order.</p>
      )}
      <div className="pt-1">
        <Button disabled={actionBusy}>Save schedule</Button>
      </div>
    </form>
  );
}

// S6. Correcting where the order came from.
//
// Notice what is NOT here: entry method. It records how the record was typed in, which no amount of
// correcting the acquisition channel can change -- a hand-typed Instagram order is source=instagram
// AND entry_method=manual, both at once. There is no input for it and the update payload has no
// column for it.
function AttributionEditForm({
  actionBusy,
  onSubmit,
  order,
}: {
  actionBusy: boolean;
  onSubmit: (attribution: { expectedUpdatedAt: string; source: OrderSource; sourceRef: string }) => void;
  order: Order;
}) {
  // Same one-snapshot rule as the schedule form: version and values are captured together.
  const [renderedVersion] = useState(order.updatedAt);
  const [source, setSource] = useState<OrderSource>(order.source);
  const [sourceRef, setSourceRef] = useState(order.sourceRef);

  return (
    <form
      className="grid gap-2 rounded-md border border-[#e8dccd] p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        // Submitted exactly as typed. Not trimmed, because this value is opaque and the app has no
        // standing to decide which of its characters matter.
        onSubmit({ expectedUpdatedAt: renderedVersion, source, sourceRef });
      }}
    >
      <p className="font-semibold">Edit source</p>
      <label className="grid gap-1 font-medium">
        Where did this order come from?
        <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => setSource(event.target.value as OrderSource)} value={source}>
          {ORDER_SOURCES.map((option) => <option key={option} value={option}>{option === "unknown" ? "Unknown" : option}</option>)}
        </select>
      </label>
      <label className="grid gap-1 font-medium">
        Reference <span className="font-normal text-[#6f5a4c]">(optional)</span>
        <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => setSourceRef(event.target.value)} placeholder="post link, campaign tag, who referred them" value={sourceRef} />
        <span className="font-normal leading-5 text-[#6f5a4c]">Kept exactly as written, for your own reference. Nothing reads it.</span>
      </label>
      <div className="pt-1">
        <Button disabled={actionBusy}>Save source</Button>
      </div>
    </form>
  );
}

// datetime-local wants a local "YYYY-MM-DDTHH:mm", not an ISO instant.
function toLocalDateTimeValue(iso: string | null): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const offset = parsed.getTimezoneOffset() * 60000;
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 16);
}
