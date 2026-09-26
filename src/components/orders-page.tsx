"use client";

// Orders Workspace V1.1: the operationally-focused Orders surface.
//
// Scope is S2 + S3 + S4 + S5 + S6, which is the whole approved MVP: create an order, move it
// through its lifecycle, record payment against it, correct the agreed handover facts, and correct
// where it came from. Order LINES are still not editable after creation -- that is deliberate and
// unchanged, and everything downstream of it (see updatePaymentStatus's caller-supplied lines)
// depends on it staying that way.
//
// V1.1 moved sales analytics (the selectable reporting period, Most Ordered, Sources) to Dashboard
// -- Orders answers "what do I need to do right now", not "how is the business doing". What remains
// here: Order operations (Needs attention, To prepare today -- presentation only, every rule decided
// by src/lib/orders/summary.ts), Finished Stock & Demand (shared with Dashboard), and the order
// list itself, now split into Active Orders (everything still open for handover, reusing
// transitions.ts's own lifecycle classification -- never a second one) and Recent Orders (terminal
// history, 5 at a time). No public ordering surface lives here.
//
// Data access goes through src/lib/orders-repository.ts. Orders never enter LabState. The catalog
// (products, batches, costings, selling formats) is read from LabState because it is already
// loaded there; nothing about orders is written back into it.

import { ArrowLeft, ClipboardList, PackagePlus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FinishedStockDemandSection } from "@/components/finished-stock-demand-section";
import { OrdersSummary } from "@/components/orders-summary";
import { Button, MessageBox, Panel, SecondaryButton, Tag } from "@/components/ui";
import { sliceFinishedStockDemandRows, buildFinishedStockDemand } from "@/lib/dashboard/finished-stock-demand";
import { buildSellingSummary } from "@/lib/orders/summary";
import { createMutationGuard } from "@/lib/mutation-guard";
import { toDisplayPrice } from "@/lib/orders/money";
import { filterOrdersByFulfillment, FULFILLMENT_FILTERS, FULFILLMENT_SORTS, getActiveDeliveryAddress, sortOrdersByFulfillment, type FulfillmentFilter, type FulfillmentSort } from "@/lib/orders/fulfillment";
import { applyItemChoice, buildLinesFromDrafts, CUSTOM_ITEM_KEY, describePieceCount, describeUnorderableReason, findSellableItem, getSellableItems, getSellableOptionLabel, getUnorderableProducts, sanitizeQuantityInput, settleQuantity, stepQuantity, type DraftLine, type SellableProductGroup, type UnorderableProduct } from "@/lib/orders/menu";
import { filterOrdersBySearch, formatOrderItemSummary, getOrderCardSource, getOrderCardTimes, getOrdersLayoutClass, getPaymentTone } from "@/lib/orders/list-view";
import { appearsSafeToDelete, buildDeleteConfirmation } from "@/lib/orders/delete-eligibility";
import { describeDraftStockRow, describeOrderStockRow, getStockReadiness, type StockReadiness } from "@/lib/orders/stock-readiness";
import { getOrderTotals, getPaymentDivergence } from "@/lib/orders/totals";
import { CLOSED_ORDER_STATUSES, getAllowedOrderTransitions, isOpenForHandover, isValidOrderTransition, orderStatusChangeMovesStock } from "@/lib/orders/transitions";
import { findPossibleDuplicateCustomer } from "@/lib/orders/validation";
import { isPaymentMethod, ORDER_SOURCES, PAYMENT_METHODS, type Customer, type FulfillmentMethod, type Order, type OrderLine, type OrderSource, type OrderStatus, type PaymentMethod } from "@/lib/orders/types";
import { listCustomers, listOrderLines, listOrderRawCogs, listOrders, safeDeleteOrder, submitNewOrder, updateOrderAttribution, updateOrderFulfillment, updateOrderStatus, updatePaymentStatus, type OrdersClient, type PaymentAction } from "@/lib/orders-repository";
import type { OrderRawCogs } from "@/lib/product-lab-types";
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

export function OrdersPage({ initialIsCreating = false, labState, onDirtyChange, onStockChanged }: {
  // Mirrors Today's ?job=<id> resume pattern (create-now.ts's resolveCreateNowJobId, read
  // server-side in src/app/orders/page.tsx): a plain URL query param resolved into a typed initial
  // value, not client-side cross-page state. Lets a "New order" link elsewhere (Dashboard's quick
  // action) open this form directly via /orders?new=1, reusing this exact existing form/business
  // logic rather than inventing a second create-order surface.
  initialIsCreating?: boolean;
  labState: LabState;
  onDirtyChange: (isDirty: boolean) => void;
  // Reloads the parent's authoritative LabState (finished-stock movements included) after an order
  // change that moved stock. Resolves false when that reload did not succeed. Orders never queries
  // finished stock itself -- see the stock-readiness memos below, which read labState.
  onStockChanged: () => Promise<boolean>;
}) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [linesByOrderId, setLinesByOrderId] = useState<Map<string, OrderLine[]>>(new Map());
  // Wave 3: derived raw-production COGS per order, keyed by order id. Supplementary -- see
  // listOrderRawCogs' own header for why a failure to read it never blocks the rest of this page.
  const [rawCogsByOrderId, setRawCogsByOrderId] = useState<Map<string, OrderRawCogs>>(new Map());
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [loadFailure, setLoadFailure] = useState<{ reason: "missing-table" | "failed"; message: string } | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"good" | "bad" | "info">("info");
  const [isCreating, setIsCreating] = useState(initialIsCreating);

  // Orders Workspace V1.1. How many Recent (terminal) orders are revealed, 5 at a time -- plain,
  // page-local, never gates or re-triggers the loader above. Whether the viewport is narrow enough
  // that order detail should be a full-screen overlay rather than a side panel -- see the dialog
  // effect below.
  const [recentRevealCount, setRecentRevealCount] = useState(5);
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  // Mobile Orders primary action: below lg (the app shell's own mobile/desktop split, distinct from
  // the xl-based isNarrowViewport above), the primary New order action moves near the top of the
  // page instead of staying in the Orders list header. Its own breakpoint since it answers a
  // different question ("is this a mobile layout") than isNarrowViewport ("should order detail be an
  // overlay").
  const [isMobileWidth, setIsMobileWidth] = useState(false);

  // S5 list controls. Client-side over the orders already loaded -- no extra round trip, and the
  // defaults ("all", newest first) leave the list exactly as S2 shipped it.
  const [fulfillmentFilter, setFulfillmentFilter] = useState<FulfillmentFilter>("all");
  const [fulfillmentSort, setFulfillmentSort] = useState<FulfillmentSort>("placed");
  // Client-side over what is already loaded; empty means the list is exactly as it was.
  const [searchQuery, setSearchQuery] = useState("");
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
  const detailDialogRef = useRef<HTMLDialogElement | null>(null);

  const client = supabase as unknown as OrdersClient | null;

  // Below xl (the same breakpoint the desktop side panel already used), order detail becomes a
  // full-screen overlay instead of an in-flow panel -- see the dialog effect below. Reactive to
  // resize/rotation, not a one-shot check.
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1279px)");
    const update = () => setIsNarrowViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // Below lg (1024px, matching app-shell.tsx's own mobile/desktop split), the primary New order
  // action relocates -- see its render site below. Reactive to resize/rotation, not a one-shot check.
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobileWidth(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // ?new=1 is an INITIAL instruction only (mirrors create-now.tsx's own setActiveJob: a plain
  // url.searchParams mutation plus window.history.replaceState, never a full navigation). Once it
  // has done its one job -- seeding isCreating's initial value above -- it is stripped from the URL
  // immediately, so a later browser Refresh (whether the operator cancels or completes the form)
  // reads a clean /orders and never reopens New Order solely because a stale param survived. Any
  // other query parameter already on the URL is left untouched.
  useEffect(() => {
    if (!initialIsCreating) {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("new");
    window.history.replaceState(null, "", url);
  }, [initialIsCreating]);

  // Opens/closes the mobile detail dialog imperatively -- <dialog> has no declarative "open" prop
  // this codebase can rely on across browsers, so a ref + showModal()/close() is the standard way to
  // drive it. Only ever called while narrow; the desktop side panel (a plain div, not this dialog)
  // is untouched by this effect entirely. Unmounting the dialog (selectedOrderId or isNarrowViewport
  // becoming false) runs this cleanup, so body scroll is never left locked.
  useEffect(() => {
    if (!isNarrowViewport || !selectedOrderId) {
      return;
    }
    const dialog = detailDialogRef.current;
    if (!dialog) {
      return;
    }
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = "";
    };
  }, [selectedOrderId, isNarrowViewport]);

  const sellableGroups: SellableProductGroup[] = useMemo(
    () => getSellableItems(labState.products, labState.batches, labState.costings, labState.sellingFormats),
    [labState.products, labState.batches, labState.costings, labState.sellingFormats],
  );
  const unorderableProducts: UnorderableProduct[] = useMemo(
    () => getUnorderableProducts(labState.products, labState.batches, labState.costings, labState.sellingFormats),
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

      // Supplementary, loaded after the page is already usable and never gating it: a caller that
      // cannot read order_raw_cogs (RLS, or a pre-Wave-3 database) still gets a fully working
      // Orders page, just without the COGS figure.
      const cogsResult = await listOrderRawCogs(client, orderResult.orders.filter((order) => order.status === "completed").map((order) => order.id));
      if (!cancelled && cogsResult.ok) {
        setRawCogsByOrderId(cogsResult.cogsByOrderId);
      }
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

  // Wave 2. Stable operation identity for confirm/complete/cancel-with-release -- the three
  // transitions that now reserve, fulfill, or release physical stock through a DB-owned atomic
  // RPC (see updateOrderStatus). A ref, not state: this is retry bookkeeping the page never
  // renders from. Keyed by (orderId, to) rather than orderId alone, matching the same rule
  // bake-page.tsx's bakeOperationId already follows -- a retry click for the SAME attempted
  // transition reuses its id so the database treats it as one logical request; a genuinely
  // different transition (or the SAME transition attempted again after this one already
  // succeeded, via rotateTransitionOperationId) is a new attempt and gets a fresh one. Ids for
  // transitions that never reach the RPC (-> ready, new -> cancelled) are simply never read.
  const transitionOperationIdsRef = useRef(new Map<string, string>());

  function getTransitionOperationId(orderId: string, to: OrderStatus): string {
    const key = `${orderId}:${to}`;
    const existing = transitionOperationIdsRef.current.get(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    transitionOperationIdsRef.current.set(key, created);
    return created;
  }

  function rotateTransitionOperationId(orderId: string, to: OrderStatus) {
    transitionOperationIdsRef.current.delete(`${orderId}:${to}`);
  }

  // Permanent delete gets its own operation id per order, so a retry after a dropped response replays
  // the same request instead of asking the database for a second delete.
  function getDeleteOperationId(orderId: string): string {
    const key = `${orderId}:delete`;
    const existing = transitionOperationIdsRef.current.get(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    transitionOperationIdsRef.current.set(key, created);
    return created;
  }

  // Nothing is hidden optimistically: the order leaves the list only because the reload after a
  // confirmed delete no longer returns it. A refusal keeps the order, shows the database's reason,
  // and reloads so the operator sees what the order actually is now.
  async function runDeleteOrder(orderId: string, expectedUpdatedAt: string) {
    if (!client || actionGuardRef.current.isActive(orderId)) {
      return;
    }

    await actionGuardRef.current.run(orderId, async () => {
      setActionBusy(true);
      try {
        const result = await safeDeleteOrder(client, { orderId, expectedUpdatedAt, operationId: getDeleteOperationId(orderId) });
        if (result.ok) {
          transitionOperationIdsRef.current.delete(`${orderId}:delete`);
          setSelectedOrderId(null);
          setMessage("Order deleted permanently.");
          setMessageTone("good");
        } else {
          if (result.reason === "not-found") {
            setSelectedOrderId(null);
          }
          setMessage(result.message);
          setMessageTone("bad");
        }
        reload();
      } finally {
        setActionBusy(false);
      }
    });
  }

  // movesStock: this action was a confirm / complete / release, so the stock-readiness readout's
  // source data (labState.finishedStockMovements) is now out of date and is reloaded -- but only after
  // the database accepted the change. A refused change moves nothing, so it claims nothing and reloads
  // nothing here beyond the orders list it always reloaded.
  const runOrderAction = useCallback(
    async (orderId: string, action: () => Promise<{ ok: true; order: Order } | { ok: false; message: string }>, options: { movesStock?: boolean } = {}) => {
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
          if (options.movesStock) {
            const refreshed = await onStockChanged().catch(() => false);
            if (!refreshed) {
              setMessage("Order updated. Stock availability could not refresh -- reload the page to see it.");
              setMessageTone("info");
            }
          }
        } finally {
          setActionBusy(false);
        }
      });
    },
    [reload, onStockChanged],
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
  // Informational only -- Place order is never blocked by stock, and a new order reserves nothing.
  // Confirm re-checks availability in the database.
  const draftStockReadiness = useMemo(
    () => getStockReadiness(previewLines, labState.products, labState.finishedStockMovements),
    [previewLines, labState.products, labState.finishedStockMovements],
  );

  // Filter first, then sort. Both are pure reads over the loaded list, and the clock they need is
  // the load stamp above rather than a fresh reading -- so this stays a pure render.
  // Search narrows whatever the fulfilment filter kept; it composes with the filter and the sort.
  const visibleOrders = useMemo(
    () =>
      sortOrdersByFulfillment(
        filterOrdersBySearch(filterOrdersByFulfillment(orders, fulfillmentFilter, { nowMs: loadedAtMs, timeZone: BUSINESS_TIMEZONE }), {
          query: searchQuery,
          linesByOrderId,
          customerNameById: new Map(customers.map((customer) => [customer.id, customer.name])),
        }),
        fulfillmentSort,
      ),
    [orders, fulfillmentFilter, fulfillmentSort, loadedAtMs, searchQuery, linesByOrderId, customers],
  );

  // Orders Workspace V1.1: Active vs Recent, both derived from the SAME already-filtered/sorted
  // visibleOrders above -- no second filtering pipeline, and no new sort. Active/Recent reuse
  // transitions.ts's own isOpenForHandover/CLOSED_ORDER_STATUSES (moved there from summary.ts,
  // unchanged) rather than a new lifecycle meaning invented for this page: those two sets already
  // partition every OrderStatus with no gap or overlap (ORDER_STATUS_COVERAGE's own test proves
  // it), so an order can never appear in both, or in neither.
  //
  // A non-default search or fulfilment filter switches to ONE unified list (isFiltering) instead of
  // the Active/Recent split -- the 5-item Recent cap is presentation only and must never make a
  // real search/filter match harder to find.
  const isFiltering = searchQuery.trim() !== "" || fulfillmentFilter !== "all";
  const activeOrders = useMemo(() => visibleOrders.filter(isOpenForHandover), [visibleOrders]);
  const recentOrders = useMemo(() => visibleOrders.filter((order) => CLOSED_ORDER_STATUSES.includes(order.status)), [visibleOrders]);
  const visibleRecentOrders = recentOrders.slice(0, recentRevealCount);
  const hasMoreRecent = recentRevealCount < recentOrders.length;

  // S7: the readout, over the SAME loaded state the list above renders. No second query, no second
  // loader, no second cache -- reloading refreshes both, because both read `orders`/`linesByOrderId`
  // and both are stamped by the same `loadedAtMs`.
  //
  // `loadedAtMs` is the observation time of this dataset, which is what G1 wants: reading a fresh
  // clock here would let "today" advance past midnight while the numbers on screen still described
  // yesterday's load. It is 0 until the first successful load, and a 0 would resolve to 1970 in
  // Manila -- so the summary is only ever BUILT when there is something to build it from, and the
  // gate below is what guarantees that.
  const summary = useMemo(
    () => (loadedAtMs === 0 ? null : buildSellingSummary({ orders, linesByOrderId, nowMs: loadedAtMs, timeZone: BUSINESS_TIMEZONE })),
    [orders, linesByOrderId, loadedAtMs],
  );

  // Finished Stock & Demand, shared with Dashboard (see finished-stock-demand-section.tsx's
  // header) -- built directly from state this page already has loaded, not a second fetch. A
  // failed orders read is treated exactly as Dashboard treats its own: demand and shortage become
  // unknown (null), stock itself still shows. Unlike Dashboard's 5-row glance, Orders shows the
  // full list -- it is the dedicated workspace, not a glance.
  const stockDemand = useMemo(
    () =>
      buildFinishedStockDemand({
        products: labState.products,
        batches: labState.batches,
        costings: labState.costings,
        sellingFormats: labState.sellingFormats,
        movements: labState.finishedStockMovements,
        orders: loadFailure ? null : orders,
        linesByOrderId,
      }),
    [labState.products, labState.batches, labState.costings, labState.sellingFormats, labState.finishedStockMovements, orders, linesByOrderId, loadFailure],
  );
  const stockSection = sliceFinishedStockDemandRows(stockDemand, null, !loadFailure);

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
  // Only a NEW order has stock still to be reserved. Confirmed/ready orders already hold their
  // reservation and completed/cancelled ones are history, so no readout is made for them.
  const selectedStockReadiness = selectedOrder?.status === "new" ? getStockReadiness(selectedLines, labState.products, labState.finishedStockMovements) : null;

  function runPaymentAction(action: PaymentAction) {
    if (!client || !selectedOrder) return;
    const id = selectedOrder.id;
    void runOrderAction(id, () => updatePaymentStatus(client, { orderId: id, action, now: new Date().toISOString() }));
  }

  function renderOrderCards(list: Order[]) {
    return (
      <div className="space-y-2">
        {list.map((order) => (
          <OrderCard
            customerName={customers.find((entry) => entry.id === order.customerId)?.name ?? "Unknown customer"}
            isSelected={order.id === selectedOrderId}
            key={order.id}
            lines={linesByOrderId.get(order.id) ?? []}
            onSelect={() => setSelectedOrderId(order.id)}
            order={order}
          />
        ))}
      </div>
    );
  }

  const detailPanel = (
    <OrderDetailPanel
      actionBusy={actionBusy}
      customer={customers.find((entry) => entry.id === selectedOrder?.customerId) ?? null}
      lines={selectedLines}
      onCancel={(reason) => {
        if (!client || !selectedOrder) return;
        const id = selectedOrder.id;
        void runOrderAction(id, async () => {
          const operationId = getTransitionOperationId(id, "cancelled");
          const result = await updateOrderStatus(client, { orderId: id, to: "cancelled", cancelReason: reason, now: new Date().toISOString(), operationId });
          if (result.ok) rotateTransitionOperationId(id, "cancelled");
          return result;
        }, { movesStock: orderStatusChangeMovesStock(selectedOrder.status, "cancelled") });
      }}
      onClearPaymentRecord={() => runPaymentAction({ kind: "clear-record" })}
      stockReadiness={selectedStockReadiness}
      onDelete={() => {
        if (selectedOrder) void runDeleteOrder(selectedOrder.id, selectedOrder.updatedAt);
      }}
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
      rawCogs={selectedOrder ? rawCogsByOrderId.get(selectedOrder.id) ?? null : null}
      onStatusChange={(to) => {
        if (!client || !selectedOrder) return;
        const id = selectedOrder.id;
        void runOrderAction(id, async () => {
          const operationId = getTransitionOperationId(id, to);
          const result = await updateOrderStatus(client, { orderId: id, to, now: new Date().toISOString(), operationId });
          if (result.ok) rotateTransitionOperationId(id, to);
          return result;
        }, { movesStock: orderStatusChangeMovesStock(selectedOrder.status, to) });
      }}
      order={selectedOrder}
    />
  );

  // Instantiated exactly once, same discipline as detailPanel above: whichever wrapper below is
  // active (the mobile CTA block or the Orders list header) references this one instance, never a
  // second copy of the form's own JSX/business logic.
  const newOrderForm = isCreating ? (
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
      stockReadiness={draftStockReadiness}
      sellableGroups={sellableGroups}
      unorderableProducts={unorderableProducts}
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
  ) : null;

  return (
    <div className="space-y-8" id="orders">
      {/* A. Order operations -- period-independent (Needs attention, To prepare today). Sales
          analytics moved to Dashboard in V1.1; see orders-summary.tsx's own header. Below lg, this
          whole header row (title/subtitle AND Refresh) is hidden entirely: the page itself is already
          "Orders" (the active item in the primary nav says so), and Refresh is consolidated into the
          single mobile Refresh below (Mobile Operational Compression V1, Part A2) rather than existing
          here too. Unchanged at >=lg. */}
      <section className="grid gap-5">
        <div className="hidden flex-wrap items-center justify-between gap-3 lg:flex">
          <div>
            <h3 className="text-lg font-semibold">Order operations</h3>
            <p className="text-sm text-[#6f5a4c]">What needs doing right now.</p>
          </div>
          <SecondaryButton onClick={reload}>
            <span className="inline-flex items-center gap-2"><RefreshCw size={14} /> Refresh</span>
          </SecondaryButton>
        </div>

        {/* Three genuinely different conditions, told apart rather than collapsed. A summary of
            zeroes is a claim that the business is quiet; it must never be shown when the truth is
            "still loading" or "the read failed", because those look identical on screen and only
            one of them is safe to act on. `summary` is null until a load has actually succeeded.
            Below lg, OrdersSummary itself compacts each fully-empty card to one line (Part A1) --
            action-required content still renders the existing full card either way. */}
        {loadFailure ? (
          <MessageBox message={`${loadFailure.message} The summary is hidden rather than shown as zeroes, because these orders could not be read.`} tone="bad" />
        ) : isLoading || !summary ? (
          <p className="rounded-lg border border-dashed border-[#d8c7b7] p-6 text-sm text-[#6f5a4c]">Loading…</p>
        ) : (
          <OrdersSummary compact={isMobileWidth} summary={summary} />
        )}
      </section>

      {/* B. Finished stock & demand -- shared with Dashboard, see finished-stock-demand-section.tsx. */}
      <FinishedStockDemandSection section={stockSection} />

      {/* Mobile Orders primary action: below lg, New order moves here -- immediately after Stock &
          Demand, before Active/Recent Orders -- so it needs no scrolling to reach. The Orders list
          header below never renders its own New order button while this is showing (isMobileWidth),
          so there is exactly one trigger on screen at a time; newOrderForm is the same single
          instance either way. Not sticky/fixed -- normal document flow. */}
      {isMobileWidth ? (
        <div className="space-y-4">
          <div className="flex gap-2">
            <button
              className="h-12 flex-1 rounded-md bg-[#8f5632] text-base font-semibold text-white hover:bg-[#774427]"
              onClick={() => { setIsCreating((value) => !value); setMessage(""); }}
              type="button"
            >
              {isCreating ? "Cancel new order" : "New order"}
            </button>
            {/* The one Orders Refresh on mobile (Part A2) -- the Order operations row above and the
                Orders list header below both hide their own Refresh while this is showing. */}
            <SecondaryButton onClick={reload}>
              <span className="inline-flex items-center gap-2"><RefreshCw size={14} /> Refresh</span>
            </SecondaryButton>
          </div>
          {newOrderForm}
        </div>
      ) : null}

      {/* C. Active Orders / D. Recent Orders -- New order stays reachable in this header regardless
          of either section's state or the search/filter/reveal state below it (desktop/>=lg; below
          lg the primary action lives in the mobile block above instead). */}
      <section className={getOrdersLayoutClass(selectedOrder !== null)}>
      <div className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Orders</h3>
            <p className="text-sm text-[#6f5a4c]">{isLoading ? "Loading…" : `${orders.length} order${orders.length === 1 ? "" : "s"} recorded`}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isMobileWidth ? null : (
              <SecondaryButton onClick={reload}>
                <span className="inline-flex items-center gap-2"><RefreshCw size={14} /> Refresh</span>
              </SecondaryButton>
            )}
            {isMobileWidth ? null : (
              <SecondaryButton onClick={() => { setIsCreating((value) => !value); setMessage(""); }}>{isCreating ? "Cancel new order" : "New order"}</SecondaryButton>
            )}
          </div>
        </div>

        {message ? <MessageBox message={message} tone={messageTone} /> : null}
        {loadFailure && loadFailure.reason === "failed" ? <MessageBox message={loadFailure.message} tone="bad" /> : null}

        {isMobileWidth ? null : newOrderForm}

        <div className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-[12rem] flex-1 gap-1 text-xs font-medium sm:max-w-xs">
            Search
            <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2" onChange={(event) => setSearchQuery(event.target.value)} placeholder="Customer, item or order id" type="search" value={searchQuery} />
          </label>
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

        {isLoading ? (
          <p className="rounded-lg border border-dashed border-[#d8c7b7] p-6 text-sm text-[#6f5a4c]">Loading…</p>
        ) : orders.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[#d8c7b7] p-6 text-sm text-[#6f5a4c]">No orders recorded yet. Use “New order” to add the first one.</p>
        ) : isFiltering ? (
          // A non-default search or filter narrows to ONE unified list -- the 5-item Recent cap is
          // presentation only and must never make a real match harder to find.
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-[#231813]">Results ({visibleOrders.length})</h4>
            {visibleOrders.length === 0 ? (
              searchQuery.trim() !== "" ? (
                <p className="rounded-lg border border-dashed border-[#d8c7b7] p-6 text-sm text-[#6f5a4c]">No orders match this search.{fulfillmentFilter !== "all" ? ` The “${FILTER_LABELS[fulfillmentFilter]}” filter is also on.` : ""}</p>
              ) : (
                <p className="rounded-lg border border-dashed border-[#d8c7b7] p-6 text-sm text-[#6f5a4c]">No orders match “{FILTER_LABELS[fulfillmentFilter]}”. The other {orders.length} {orders.length === 1 ? "order is" : "orders are"} still here — switch back to “All orders”.</p>
              )
            ) : (
              renderOrderCards(visibleOrders)
            )}
          </div>
        ) : (
          <>
            {/* C. Active Orders -- every order still open for handover, regardless of age. Never
                capped: an old unfulfilled order must not hide behind newer completed ones. */}
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-[#231813]">Active Orders ({activeOrders.length})</h4>
              {activeOrders.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[#d8c7b7] p-6 text-sm text-[#6f5a4c]">Nothing needs handling right now.</p>
              ) : (
                renderOrderCards(activeOrders)
              )}
            </div>

            {/* D. Recent Orders -- terminal history (completed/cancelled), 5 at a time. Active and
                Recent can never overlap: isOpenForHandover/CLOSED_ORDER_STATUSES partition every
                OrderStatus with no gap. */}
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-[#231813]">Recent Orders ({recentOrders.length})</h4>
              {recentOrders.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[#d8c7b7] p-6 text-sm text-[#6f5a4c]">No order history yet.</p>
              ) : (
                <>
                  {renderOrderCards(visibleRecentOrders)}
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    {hasMoreRecent ? <SecondaryButton onClick={() => setRecentRevealCount((count) => count + 5)}>Show 5 more</SecondaryButton> : null}
                    {recentRevealCount > 5 ? (
                      <button className="text-sm font-semibold text-[#8f5632] hover:underline" onClick={() => setRecentRevealCount(5)} type="button">Show less</button>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Desktop (>=xl): unchanged in-flow side panel, byte-identical to before -- no <dialog>
          involved, zero risk of native dialog styling reaching this branch. */}
      {selectedOrder && !isNarrowViewport ? <div className="min-w-0">{detailPanel}</div> : null}

      {/* Mobile (<xl): a native <dialog>, mounted (and showModal()'d by the effect above) only
          while narrow AND an order is selected -- unmounting on either condition changing (e.g. a
          resize past the breakpoint) hands off to the desktop branch above declaratively, with no
          imperative mode-switching needed. showModal() gives a real focus trap, Escape-to-cancel,
          and focus restoration on close, all native -- none of it hand-rolled. The inner flex
          column keeps the back button always reachable while only the content pane scrolls, and
          document.body is scroll-locked by the effect above so the page behind can't compete. */}
      {selectedOrder && isNarrowViewport ? (
        <dialog
          aria-label={`Order detail: ${customers.find((entry) => entry.id === selectedOrder.customerId)?.name ?? "order"}`}
          className="fixed inset-0 z-40 m-0 h-full max-h-none w-full max-w-none border-0 bg-white p-0"
          onCancel={() => setSelectedOrderId(null)}
          ref={detailDialogRef}
        >
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-[#e1d4c4] bg-white p-3">
              <button className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#5f4a3d]" onClick={() => setSelectedOrderId(null)} type="button">
                <ArrowLeft size={18} /> Orders
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">{detailPanel}</div>
          </div>
        </dialog>
      ) : null}
      </section>
    </div>
  );
}

// One order card -- shared by the unified Results list and both Active/Recent lists, so the row
// markup exists in exactly one place regardless of which section is rendering it.
function OrderCard({ customerName, isSelected, lines, onSelect, order }: {
  customerName: string;
  isSelected: boolean;
  lines: OrderLine[];
  onSelect: () => void;
  order: Order;
}) {
  const total = getOrderTotals(lines).total;
  const times = getOrderCardTimes(order);
  const cardSource = getOrderCardSource(order);
  return (
    <button
      className={`w-full rounded-lg border p-4 text-left text-sm ${isSelected ? "border-[#8f5632] bg-[#fffaf3]" : "border-[#e1d4c4] bg-white hover:bg-[#fffaf3]"}`}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words font-semibold">{customerName}</span>
        <span className="shrink-0 font-semibold">{formatPeso(total)}</span>
      </div>
      <p className="mt-1 break-words text-sm text-[#5f4a3d]">{formatOrderItemSummary(lines)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#6f5a4c]">
        <Tag tone="warm">{order.status}</Tag>
        <Tag tone={getPaymentTone(order.paymentStatus)}>{order.paymentStatus}</Tag>
        <span>Placed {formatWhen(times.placed)}</span>
      </div>
      <p className="mt-1 text-xs text-[#6f5a4c]">
        {order.fulfillmentMethod === "delivery" ? "Delivery" : "Pickup"}
        {times.handover ? ` · Handover ${formatWhen(times.handover)}` : ""}
        {cardSource ? ` · ${cardSource}` : ""}
      </p>
    </button>
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
  stockReadiness,
  sellableGroups,
  unorderableProducts,
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
  stockReadiness: StockReadiness;
  sellableGroups: SellableProductGroup[];
  unorderableProducts: UnorderableProduct[];
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
        {sellableGroups.length === 0 ? (
          <p className="text-xs leading-5 text-[#6f5a4c]">
            No orderable products are set up yet. Set up a selling format for a product in <a className="font-semibold text-[#8f5632] underline" href="/costing">Costing</a> first, or use Custom item.
          </p>
        ) : null}
        {unorderableProducts.length > 0 ? (
          // Says why a product the operator sells is missing from the dropdown. It never blocks the
          // form: the products above still order normally, and Custom item always works.
          <p className="text-xs leading-5 text-[#6f5a4c]">
            Not orderable yet: {unorderableProducts.map((entry) => `${entry.productName} (${describeUnorderableReason(entry.reason)})`).join(", ")}.{sellableGroups.length > 0 ? <> Add a selling format in <a className="font-semibold text-[#8f5632] underline" href="/costing">Costing</a>.</> : null}
          </p>
        ) : null}
        {draftLines.map((line) => {
          const item = line.itemKey && line.itemKey !== CUSTOM_ITEM_KEY ? findSellableItem(sellableGroups, line.itemKey) : null;
          return (
            <div className="grid gap-2 rounded-md border border-[#e8dccd] p-3 sm:grid-cols-[minmax(0,2fr)_156px_110px_auto]" key={line.rowId}>
              <label className="grid gap-1 text-xs font-medium">
                Item
                <select
                  className="h-10 min-w-0 rounded-md border border-[#d8c7b7] bg-white px-2"
                  onChange={(event) => updateLine(line.rowId, applyItemChoice(line, event.target.value, sellableGroups))}
                  value={line.itemKey}
                >
                  <option value="">Choose an item…</option>
                  {sellableGroups.map((group) => (
                    <optgroup key={group.productId} label={group.productName}>
                      {group.items.map((option) => <option key={option.key} value={option.key}>{getSellableOptionLabel(option)}</option>)}
                    </optgroup>
                  ))}
                  <option value={CUSTOM_ITEM_KEY}>Custom item…</option>
                </select>
              </label>

              <div className="grid gap-1 text-xs font-medium" role="group" aria-label="Quantity in selling units">
                Qty
                {/* Whole selling units only (2.5 boxes is not enterable). A text input with a numeric
                    keypad instead of type=number, so there are no tiny native spinner arrows. */}
                <div className="flex items-center gap-1">
                  <button aria-label="Decrease quantity" className="h-11 w-11 shrink-0 rounded-md border border-[#d8c7b7] bg-white text-lg font-semibold text-[#5f4a3d] hover:bg-[#fffaf3]" onClick={() => updateLine(line.rowId, { quantity: stepQuantity(line.quantity, -1) })} type="button">−</button>
                  <input aria-label="Quantity" className="h-11 w-14 min-w-0 rounded-md border border-[#d8c7b7] bg-white px-1 text-center text-base" inputMode="numeric" onBlur={() => updateLine(line.rowId, { quantity: settleQuantity(line.quantity) })} onChange={(event) => updateLine(line.rowId, { quantity: sanitizeQuantityInput(event.target.value) })} pattern="[0-9]*" type="text" value={line.quantity} />
                  <button aria-label="Increase quantity" className="h-11 w-11 shrink-0 rounded-md border border-[#d8c7b7] bg-white text-lg font-semibold text-[#5f4a3d] hover:bg-[#fffaf3]" onClick={() => updateLine(line.rowId, { quantity: stepQuantity(line.quantity, 1) })} type="button">+</button>
                </div>
              </div>

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
                <p className="text-xs text-[#6f5a4c] sm:col-span-4">
                  {describePieceCount(line.quantity, item.piecesPerUnit) ? <span className="font-semibold text-[#5f4a3d]">{describePieceCount(line.quantity, item.piecesPerUnit)}</span> : null}
                  {describePieceCount(line.quantity, item.piecesPerUnit) ? " · " : null}
                  {item.piecesPerUnit} pieces per unit · snapshotted with this line
                </p>
              ) : null}
            </div>
          );
        })}
        <div>
          <SecondaryButton onClick={() => setDraftLines((lines) => [...lines, newDraftLine()])}>Add item</SecondaryButton>
        </div>
        {stockReadiness.rows.length > 0 || stockReadiness.hasUncheckedLines ? (
          // Informational. "Available" is on hand minus stock already reserved by confirmed orders;
          // nothing is reserved by placing this order.
          <div className="grid gap-1 rounded-md bg-[#fffaf3] p-3 text-xs leading-5 text-[#5f4a3d]">
            <p className="font-semibold">Finished stock</p>
            {stockReadiness.rows.map((row) => {
              const described = describeDraftStockRow(row);
              return (
                <p key={row.productId}>
                  <span className="font-semibold">{row.productName}</span> · {described.summary} · <span className={described.isShort ? "font-semibold text-[#a3392b]" : "text-[#2f6b3a]"}>{described.outcome}</span>
                </p>
              );
            })}
            {stockReadiness.hasUncheckedLines ? <p>Stock not tracked for custom item.</p> : null}
            <p>Stock is checked again when you Confirm the order. Nothing is reserved until then.</p>
          </div>
        ) : null}
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
  onDelete,
  stockReadiness,
  onCorrectPaymentRecord,
  onEditAttribution,
  onEditFulfillment,
  onMarkPaid,
  onRefund,
  rawCogs,
  onStatusChange,
  order,
}: {
  actionBusy: boolean;
  customer: Customer | null;
  lines: OrderLine[];
  onCancel: (reason: string) => void;
  onClearPaymentRecord: () => void;
  // Permanent delete of an accidental order. Offered only when it appears safe; the database has the
  // final say and can still refuse it.
  onDelete: () => void;
  // Set only for a NEW order. Informational: Confirm still asks the database, which decides.
  stockReadiness: StockReadiness | null;
  onCorrectPaymentRecord: (correction: { paidAmount: number; paidAt: string; method: PaymentMethod }) => void;
  // Both carry expectedUpdatedAt: the version of the order the edit form was populated from, so a
  // stale form is rejected by the conditional update rather than silently overwriting a newer row.
  onEditAttribution: (attribution: { expectedUpdatedAt: string; source: OrderSource; sourceRef: string }) => void;
  onEditFulfillment: (fulfillment: { expectedUpdatedAt: string; fulfillmentMethod: FulfillmentMethod; fulfillmentAt: string | null; fulfillmentAddress: string }) => void;
  onMarkPaid: (method: PaymentMethod) => void;
  onRefund: () => void;
  // Wave 3: derived raw-production COGS for a COMPLETED order, null for every other status (there
  // is nothing fulfilled to cost yet) and null when it simply has no fulfilled stock-tracked lines
  // (a 100% manual/hand-priced order). Ingredient cost only -- see its own render below for the
  // exact wording; never labelled as total cost or profit.
  rawCogs: OrderRawCogs | null;
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

        {/* Wave 3. Ingredient cost only -- never packaging, labor, utilities, delivery, or payment
            fees, and never presented as profit or a full cost figure. Absent (rawCogs null) for
            anything that isn't a completed order with at least one fulfilled stock-tracked line;
            no zero placeholder is shown for those, since "not applicable" and "zero cost" are
            different facts. */}
        {order.status === "completed" && rawCogs ? (
          <div className="rounded-md bg-[#f7f2ea] p-3 text-xs text-[#5f4a3d]">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Raw production COGS</span>
              <span className="font-semibold">{formatPeso(rawCogs.rawProductionCogs)}</span>
            </div>
            <p className="mt-1">{rawCogs.fulfilledPieces} fulfilled piece{rawCogs.fulfilledPieces === 1 ? "" : "s"} · avg {formatPeso(rawCogs.fulfilledPieces > 0 ? rawCogs.rawProductionCogs / rawCogs.fulfilledPieces : 0)}/piece</p>
            <p className="mt-1 text-[#8a3827]">Ingredient cost only, frozen at the exact production run(s) that supplied this order -- not packaging, labor, utilities, delivery, or payment fees, and not a profit figure.</p>
            {rawCogs.lots.length > 1 ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {rawCogs.lots.map((lot) => (
                  <li key={lot.productionExecutionId}>{lot.fulfilledPieces} pcs @ {formatPeso(lot.frozenCostPerPiece)}/pc = {formatPeso(lot.lotRawCogs)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {divergence.state === "diverged" ? (
          // Informational only. A changed order total is NOT evidence that money moved, so there is
          // deliberately no "reconcile to current total" action anywhere on this panel.
          <div className="rounded-md bg-[#fff2d8] p-3 text-xs text-[#7a531d]">
            <p>Current total {formatPeso(divergence.currentTotal)} · paid {formatPeso(divergence.paidAmount)} · ⚠ {formatPeso(Math.abs(divergence.difference))} difference</p>
            <p className="mt-1 font-semibold">This does not change what was received.</p>
          </div>
        ) : null}

        {order.notes ? <p className="text-xs">{order.notes}</p> : null}

        {stockReadiness && stockReadiness.rows.length > 0 ? (
          <div className="grid gap-1 rounded-md bg-[#fffaf3] p-3 text-xs leading-5 text-[#5f4a3d]">
            <p className="font-semibold">Stock for confirmation</p>
            {stockReadiness.rows.map((row) => {
              const described = describeOrderStockRow(row);
              return (
                <p key={row.productId}>
                  <span className="font-semibold">{row.productName}</span> · {described.summary} · <span className={described.isShort ? "font-semibold text-[#a3392b]" : "text-[#2f6b3a]"}>{described.outcome}</span>
                </p>
              );
            })}
            {stockReadiness.hasUncheckedLines ? <p>Stock not tracked for custom item.</p> : null}
            <p>Availability is checked again when you Confirm.</p>
          </div>
        ) : null}

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
          {appearsSafeToDelete(order) ? (
            // Deliberately quieter than Cancel and styled as destructive. Cancel keeps history; this
            // removes the order, so it is only for one created by mistake.
            <button
              className="h-10 rounded-md border border-[#e2b8b0] bg-white px-4 text-sm font-semibold text-[#a3392b] hover:bg-[#fff5f3] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={actionBusy}
              onClick={() => {
                if (window.confirm(buildDeleteConfirmation(customer?.name ?? null))) {
                  onDelete();
                }
              }}
              type="button"
            >
              Delete permanently
            </button>
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
