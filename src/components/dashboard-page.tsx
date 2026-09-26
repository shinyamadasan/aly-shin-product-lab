"use client";

// Operations Dashboard V1 -- the home page.
//
// A calm read of the bakery's day: what came in and got paid, what needs attention, whether there is
// enough finished stock for the orders that have not been reserved yet, and which ingredients need a
// look. It summarises; it never edits, and it never lists every order or every ingredient -- those
// live on /orders and /inventory, one click away.
//
// Everything shown is decided in src/lib/dashboard/model.ts, which composes the existing owners
// (buildSellingSummary, deriveFinishedStockBalances, the inventory-status helpers). This file loads
// the one thing LabState does not carry -- orders -- through the existing repository, and renders.
// It imports no revenue.ts, pieces.ts, attribution.ts or fulfillment.ts and computes nothing from an
// order array itself; a structural test holds that line.
//
// Orders can fail on their own. When they do, the selling zone says so and the rest of the page still
// renders -- and "You're caught up" is never claimed over an order book that was never read.

import { AlertTriangle, ArrowRight, CheckCircle2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FinishedStockDemandSection } from "@/components/finished-stock-demand-section";
import { collapsedBusinessPerformanceSummary, SalesAnalyticsSection } from "@/components/sales-analytics-section";
import { MessageBox, SectionCard, SectionHeading, ViewAllLink } from "@/components/ui";
import { BUSINESS_TIMEZONE } from "@/lib/business-day";
import { buildDashboardModel, type AttentionItem, type DashboardModel, type OrdersSnapshot } from "@/lib/dashboard/model";
import type { InventoryExceptionReason, InventoryExceptionRow } from "@/lib/dashboard/inventory-exceptions";
import type { LabState } from "@/lib/lab-state";
import { buildSalesPeriodOverview, DEFAULT_SALES_PERIOD, resolveSalesPeriodRange, type SalesPeriodOverview, type SalesPeriodSelection } from "@/lib/orders/summary";
import { listOrderLines, listOrders, type OrdersClient } from "@/lib/orders-repository";
import { supabase } from "@/lib/supabase";

const NOT_CONFIGURED: OrdersSnapshot = { status: "unavailable", reason: "not-configured", message: "Orders need a connected database." };

function formatBusinessDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

// --- Zone 1: sales analytics ------------------------------------------------------------------

function SellingUnavailable({ onRetry, selling }: { onRetry: () => void; selling: Extract<DashboardModel["selling"], { status: "unavailable" }> }) {
  const headline =
    selling.reason === "missing-table"
      ? "Orders aren't set up in this database yet."
      : selling.reason === "not-configured"
        ? "Sales figures need a connected database."
        : "Couldn't load your order numbers.";
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-[#e8c9a0] bg-[#fff6e8] p-4" role="status">
      <AlertTriangle className="mt-0.5 shrink-0 text-[#b3701f]" size={18} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[#5f3d12]">{headline}</p>
        <p className="mt-1 text-sm text-[#7a5b33]">Sales, unpaid and order attention are hidden until this loads. Stock and inventory below are unaffected.</p>
        {selling.reason === "failed" && selling.message ? <p className="mt-1 break-words text-xs text-[#8a6d4f]">{selling.message}</p> : null}
      </div>
      {selling.reason === "failed" ? (
        <button className="inline-flex h-9 items-center gap-2 rounded-md border border-[#e8c9a0] bg-white px-3 text-sm font-semibold text-[#8f5632]" onClick={onRetry} type="button">
          <RefreshCw size={14} /> Try again
        </button>
      ) : null}
    </div>
  );
}

function SalesZone({
  model,
  onPeriodChange,
  onRetry,
  overview,
  period,
}: {
  model: DashboardModel;
  onPeriodChange: (next: SalesPeriodSelection) => void;
  onRetry: () => void;
  overview: SalesPeriodOverview | null;
  period: SalesPeriodSelection;
}) {
  const { selling, summary } = model;

  if (selling.status === "unavailable") {
    return <SellingUnavailable onRetry={onRetry} selling={selling} />;
  }

  // overview is built alongside `summary` from the same loaded orders (see DashboardPage), so
  // `!overview` here means the same "not ready yet" state as `selling.status === "loading"`.
  if (selling.status === "loading" || !summary || !overview) {
    return (
      <div aria-busy="true" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((slot) => (
          <div className="h-[104px] animate-pulse rounded-lg border border-[#e1d4c4] bg-[#fffaf3]" key={slot} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <SalesAnalyticsSection
        onPeriodChange={onPeriodChange}
        overview={overview}
        period={period}
        unpaidCount={summary.attention.unpaidCount}
        unpaidValue={summary.attention.unpaidValue}
      />
      {!selling.hasOrders ? (
        <p className="mt-3 text-sm text-[#6f5a4c]">
          No orders yet. Once you add one it will show up here. <a className="font-semibold text-[#8f5632] hover:underline" href="/orders">Go to Orders</a>
        </p>
      ) : null}
    </div>
  );
}

// --- Zone 2: needs attention -----------------------------------------------------------------

function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <li>
      <a className="flex items-center justify-between gap-3 py-2.5 hover:bg-[#fffaf3]" href={item.href}>
        <span className="min-w-0 text-sm text-[#5f4a3d]">
          <span className={`mr-2 inline-block min-w-6 text-lg font-semibold tabular-nums ${item.urgent ? "text-[#b3441f]" : "text-[#231813]"}`}>{item.count}</span>
          {item.label}
          {item.value ? <span className="ml-2 font-semibold tabular-nums text-[#231813]">· {item.value}</span> : null}
        </span>
        <ArrowRight className="shrink-0 text-[#b9a48f]" size={14} />
      </a>
    </li>
  );
}

function AttentionZone({ model }: { model: DashboardModel }) {
  const { attention, selling } = model;

  return (
    <SectionCard label="Needs attention">
      <SectionHeading>Needs attention</SectionHeading>
      {attention.isCaughtUp ? (
        <p className="flex items-center gap-2 text-sm text-[#2e6b44]">
          <CheckCircle2 size={18} /> You&apos;re caught up.
        </p>
      ) : null}
      {attention.items.length > 0 ? <ul className="divide-y divide-[#f0e6da]">{attention.items.map((item) => <AttentionRow item={item} key={item.key} />)}</ul> : null}
      {selling.status === "loading" ? <p className="mt-2 text-sm text-[#8a7c6d]">Checking orders…</p> : null}
      {selling.status === "unavailable" ? (
        <p className="mt-2 text-sm text-[#7a5b33]">Order status can&apos;t be checked right now, so this list may be incomplete.</p>
      ) : null}
    </SectionCard>
  );
}

// --- Zone 3: finished stock & demand ---------------------------------------------------------
// Rendered by the shared FinishedStockDemandSection (src/components/finished-stock-demand-section.tsx),
// also used by the Orders workspace -- see that file's header for why this stays one implementation.

// --- Zone 4: inventory attention -------------------------------------------------------------

function reasonLabel(reason: InventoryExceptionReason): { text: string; tone: "danger" | "warn" } {
  if (reason.kind === "stock") {
    // Inventory Stock Status V1's 3 alerting urgency levels (Good/Not configured never reach here).
    if (reason.status === "out_of_stock") return { text: "Out of Stock", tone: "danger" };
    if (reason.status === "critical") return { text: "Critical", tone: "danger" };
    return { text: "Reorder Soon", tone: "warn" };
  }
  if (reason.kind === "expiry") {
    if (reason.status === "expired") return { text: "Expired", tone: "danger" };
    if (reason.status === "expires-today") return { text: "Expires today", tone: "danger" };
    return { text: `Expires ${reason.date}`, tone: "warn" };
  }
  return { text: "Needs review", tone: "warn" };
}

function InventoryRow({ row }: { row: InventoryExceptionRow }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-[#231813]">{row.name}</p>
        <p className="text-xs tabular-nums text-[#8a7c6d]">{row.currentQuantity} {row.baseUnit} left</p>
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        {row.reasons.map((reason, index) => {
          const { text, tone } = reasonLabel(reason);
          return (
            <span className={`rounded-sm px-2 py-0.5 text-xs font-medium ${tone === "danger" ? "bg-[#fde6df] text-[#8a3827]" : "bg-[#fff2d8] text-[#7a531d]"}`} key={`${reason.kind}-${index}`}>
              {text}
            </span>
          );
        })}
      </div>
    </li>
  );
}

function InventoryZone({ hasIngredients, model }: { hasIngredients: boolean; model: DashboardModel }) {
  const { inventory } = model;
  return (
    <SectionCard label="Inventory attention">
      <SectionHeading>Inventory attention</SectionHeading>
      {inventory.rows.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-[#2e6b44]">
          <CheckCircle2 size={18} /> {hasIngredients ? "Inventory looks healthy." : "No ingredients tracked yet."}
        </p>
      ) : (
        <ul className="divide-y divide-[#f0e6da]">{inventory.rows.map((row) => <InventoryRow key={row.ingredientId} row={row} />)}</ul>
      )}
      {inventory.hiddenCount > 0 ? <p className="mt-2 text-sm text-[#6f5a4c]">+{inventory.hiddenCount} more</p> : null}
      <ViewAllLink href="/inventory">View inventory</ViewAllLink>
    </SectionCard>
  );
}

// --- Page ------------------------------------------------------------------------------------

export function DashboardPage({ labState, message, messageTone }: { labState: LabState; message: string; messageTone: "good" | "bad" | "info" }) {
  const client = supabase as unknown as OrdersClient | null;
  const [loaded, setLoaded] = useState<OrdersSnapshot>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  // The clock is read where the data is read, never during render, so a tab left open overnight
  // keeps describing the moment it was last loaded until Refresh. Inventory dates need a "today"
  // even before orders arrive, hence the mount-time value.
  const [mountedAtMs, setMountedAtMs] = useState(() => Date.now());
  // Orders Workspace V1.1: the Sales Analytics reporting period. Plain page state, not part of
  // buildDashboardModel -- the same split V1 already used for Orders, so the model stays exactly
  // what dashboard-model.test.ts already exercises (no new required params).
  const [period, setPeriod] = useState<SalesPeriodSelection>(DEFAULT_SALES_PERIOD);
  // Mobile Operational Compression V1: same matchMedia("(max-width: 1023px)")/lg-breakpoint pattern
  // already proven in orders-page.tsx, reactive to resize/rotation, not a one-shot check.
  const [isMobileWidth, setIsMobileWidth] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobileWidth(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // "No Supabase configured" is a static fact of the environment, handled as a render condition.
      if (!client) {
        return;
      }
      try {
        const orderResult = await listOrders(client);
        if (cancelled) return;
        if (!orderResult.ok) {
          setLoaded({ status: "unavailable", reason: orderResult.reason, message: orderResult.message });
          return;
        }
        const lineResult = await listOrderLines(client, orderResult.orders.map((order) => order.id));
        if (cancelled) return;
        if (!lineResult.ok) {
          setLoaded({ status: "unavailable", reason: lineResult.reason, message: lineResult.message });
          return;
        }
        setLoaded({ status: "ready", orders: orderResult.orders, linesByOrderId: lineResult.linesByOrderId, loadedAtMs: Date.now() });
      } catch (error) {
        // A thrown read is contained the same way a reported one is: the selling zone says so, the
        // rest of the page carries on.
        if (!cancelled) {
          setLoaded({ status: "unavailable", reason: "failed", message: error instanceof Error ? error.message : "Unexpected error." });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [client, reloadToken]);

  function refresh() {
    setLoaded({ status: "loading" });
    setMountedAtMs(Date.now());
    setReloadToken((token) => token + 1);
  }

  const orders: OrdersSnapshot = client ? loaded : NOT_CONFIGURED;
  const nowMs = orders.status === "ready" ? orders.loadedAtMs : mountedAtMs;
  const model = useMemo(() => buildDashboardModel({ labState, orders, nowMs }), [labState, orders, nowMs]);

  // A second, independent readout over the same loaded orders `model.summary` already comes from --
  // reuses buildSalesPeriodOverview/resolveSalesPeriodRange (orders/summary.ts) exactly as Orders
  // Workspace V1's own orders-page.tsx already does, nothing here recomputes a formula.
  const overview = useMemo(
    () =>
      orders.status === "ready"
        ? buildSalesPeriodOverview({ orders: orders.orders, linesByOrderId: orders.linesByOrderId, range: resolveSalesPeriodRange(period, nowMs, BUSINESS_TIMEZONE) })
        : null,
    [orders, period, nowMs],
  );

  return (
    <DashboardView
      hasIngredients={labState.ingredients.length > 0}
      isMobileWidth={isMobileWidth}
      message={message}
      messageTone={messageTone}
      model={model}
      onPeriodChange={setPeriod}
      onRefresh={refresh}
      overview={overview}
      period={period}
    />
  );
}

// Presentational: renders a finished model and nothing else.
export function DashboardView({
  hasIngredients,
  isMobileWidth,
  message,
  messageTone,
  model,
  onPeriodChange,
  onRefresh,
  overview,
  period,
}: {
  hasIngredients: boolean;
  isMobileWidth: boolean;
  message: string;
  messageTone: "good" | "bad" | "info";
  model: DashboardModel;
  onPeriodChange: (next: SalesPeriodSelection) => void;
  onRefresh: () => void;
  overview: SalesPeriodOverview | null;
  period: SalesPeriodSelection;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[#6f5a4c]">{formatBusinessDay(model.businessDay)} · Manila</p>
        <button className="inline-flex h-9 items-center gap-2 rounded-md border border-[#e1d4c4] bg-white px-3 text-sm font-medium text-[#5f4a3d] hover:bg-[#fffaf3]" onClick={onRefresh} type="button">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {message ? <MessageBox message={message} tone={messageTone} /> : null}
      {isMobileWidth ? (
        <MobileDashboard model={model} onPeriodChange={onPeriodChange} onRefresh={onRefresh} overview={overview} period={period} />
      ) : (
        // DOM order is the mobile order (attention, sales, stock, inventory). From xl the same four
        // zones are re-seated: sales across the top, then attention over stock on the left with
        // inventory down the right. Unchanged by Mobile Operational Compression V1 -- isMobileWidth
        // uses a different (lg) breakpoint than this grid's own xl reflow, so >=lg (including the
        // 1024-1279px tablet range) renders exactly this branch, exactly as before.
        <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] xl:items-start">
          <div className="xl:order-2">
            <AttentionZone model={model} />
          </div>
          <div className="xl:order-1 xl:col-span-2">
            <SalesZone model={model} onPeriodChange={onPeriodChange} onRetry={onRefresh} overview={overview} period={period} />
          </div>
          <div className="xl:order-4">
            <FinishedStockDemandSection section={model.stock} />
          </div>
          <div className="xl:order-3 xl:row-span-2">
            <InventoryZone hasIngredients={hasIngredients} model={model} />
          </div>
        </div>
      )}
    </div>
  );
}

// --- Mobile Operational Compression V1 -------------------------------------------------------
//
// Action first, analytics on demand. Reorders/recomposes the SAME zones above -- nothing here
// recomputes a number: MobileAttentionZone reuses the existing AttentionRow/InventoryRow and the
// existing model.attention/model.inventory data; MobileBusinessPerformance reuses the existing
// SalesAnalyticsSection and SellingUnavailable. Desktop (the branch above) is untouched.

// Part B1/B2: one combined "Needs attention" list. Renders model.attention.items in their EXISTING
// order (buildAttentionItems' own push order -- never re-derived here); at the "inventory" item's
// own position, its aggregate count line is replaced by the actual model.inventory.rows (reusing
// InventoryRow verbatim), so the operator sees WHAT needs attention, not just how many. Every other
// item (overdue/new/scheduling/ready/unpaid/stock-shortage) renders via the existing AttentionRow,
// unchanged -- so no non-inventory item is ever lost, and Unpaid keeps appearing here exactly when
// buildAttentionItems already includes it (unpaidCount > 0), with no new logic of its own (Part B3).
//
// Known limitation (Part B2): AttentionItem.urgent is a per-category boolean (true only for
// overdue/stock-shortage) and InventoryExceptionRow.reasons carries per-ingredient status strings
// (out_of_stock/critical/reorder_soon/expired/expires-today/...) -- the two are not on one comparable
// severity scale, and no existing field ranks "3 overdue handovers" against "Salted butter: Expired"
// on a single axis. Rather than inventing a synthetic cross-model priority, each model's own
// canonical order is preserved as-is; the inventory rows are simply expanded in place at the position
// the aggregate item already occupied.
function MobileAttentionZone({ model }: { model: DashboardModel }) {
  const { attention, inventory, selling } = model;

  return (
    <SectionCard label="Needs attention">
      <SectionHeading>Needs attention</SectionHeading>
      {attention.isCaughtUp ? (
        <p className="flex items-center gap-2 text-sm text-[#2e6b44]">
          <CheckCircle2 size={18} /> You&apos;re caught up.
        </p>
      ) : null}
      {attention.items.length > 0 ? (
        <ul className="divide-y divide-[#f0e6da]">
          {attention.items.map((item) =>
            item.key === "inventory"
              ? inventory.rows.map((row) => <InventoryRow key={row.ingredientId} row={row} />)
              : <AttentionRow item={item} key={item.key} />,
          )}
        </ul>
      ) : null}
      {inventory.hiddenCount > 0 ? <p className="mt-2 text-sm text-[#6f5a4c]">+{inventory.hiddenCount} more</p> : null}
      {selling.status === "loading" ? <p className="mt-2 text-sm text-[#8a7c6d]">Checking orders…</p> : null}
      {selling.status === "unavailable" ? (
        <p className="mt-2 text-sm text-[#7a5b33]">Order status can&apos;t be checked right now, so this list may be incomplete.</p>
      ) : null}
    </SectionCard>
  );
}

// Part E: the existing SalesAnalyticsSection, reused unchanged, inside a native <details> collapsed
// by default (same idiom app-shell.tsx's "More" disclosure already uses -- no new accordion
// primitive). showUnpaid=false because Unpaid already surfaces through MobileAttentionZone above
// (Part B3) when it is actually owed; compactRangeCaptions drops the date range repeated three times
// under Most ordered/Sources/Payments received, since it is already visible once at the top (Part E1).
function MobileBusinessPerformance({
  model,
  onPeriodChange,
  onRetry,
  overview,
  period,
}: {
  model: DashboardModel;
  onPeriodChange: (next: SalesPeriodSelection) => void;
  onRetry: () => void;
  overview: SalesPeriodOverview | null;
  period: SalesPeriodSelection;
}) {
  const { selling, summary } = model;

  if (selling.status === "unavailable") {
    return <SellingUnavailable onRetry={onRetry} selling={selling} />;
  }

  if (selling.status === "loading" || !summary || !overview) {
    return <div aria-busy="true" className="h-14 animate-pulse rounded-lg border border-[#e1d4c4] bg-[#fffaf3]" />;
  }

  return (
    <details className="rounded-lg border border-[#e1d4c4] bg-white">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 p-4">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Business performance</span>
        <span className="text-sm text-[#6f5a4c]">{collapsedBusinessPerformanceSummary(period, overview)}</span>
      </summary>
      <div className="border-t border-[#e1d4c4] p-4 pt-3">
        <SalesAnalyticsSection
          compactRangeCaptions
          onPeriodChange={onPeriodChange}
          overview={overview}
          period={period}
          showUnpaid={false}
          unpaidCount={summary.attention.unpaidCount}
          unpaidValue={summary.attention.unpaidValue}
        />
        {!selling.hasOrders ? (
          <p className="mt-3 text-sm text-[#6f5a4c]">
            No orders yet. Once you add one it will show up here. <a className="font-semibold text-[#8f5632] hover:underline" href="/orders">Go to Orders</a>
          </p>
        ) : null}
      </div>
    </details>
  );
}

// Part B/C/D target order: Needs attention -> Stock & Demand -> Quick actions -> Business
// performance (collapsed). Inventory Attention is not rendered separately here -- its content
// already lives inside MobileAttentionZone above (Part B1), so it is never duplicated further down.
function MobileDashboard({
  model,
  onPeriodChange,
  onRefresh,
  overview,
  period,
}: {
  model: DashboardModel;
  onPeriodChange: (next: SalesPeriodSelection) => void;
  onRefresh: () => void;
  overview: SalesPeriodOverview | null;
  period: SalesPeriodSelection;
}) {
  return (
    <div className="space-y-4">
      <MobileAttentionZone model={model} />
      <FinishedStockDemandSection section={model.stock} />
      {/* Part D: the two most useful operational actions right after Stock & Demand. Open Bake
          already exists as FinishedStockDemandSection's own trailing link just above -- it is not
          duplicated here. New order deep-opens the existing NewOrderForm on /orders via the same
          server-resolved query-param pattern Today's own ?job=<id> resume already uses (see
          src/app/orders/page.tsx) -- not fragile cross-page state, and not a label promising more
          than it does. Not sticky/fixed -- normal document flow. */}
      <a className="flex h-12 items-center justify-center rounded-md bg-[#8f5632] text-base font-semibold text-white hover:bg-[#774427]" href="/orders?new=1">
        + New order
      </a>
      <MobileBusinessPerformance model={model} onPeriodChange={onPeriodChange} onRetry={onRefresh} overview={overview} period={period} />
    </div>
  );
}
