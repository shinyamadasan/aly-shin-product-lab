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
import { MessageBox } from "@/components/ui";
import { buildDashboardModel, type AttentionItem, type DashboardModel, type OrdersSnapshot, type PulseMetric } from "@/lib/dashboard/model";
import type { InventoryExceptionReason, InventoryExceptionRow } from "@/lib/dashboard/inventory-exceptions";
import type { FinishedStockDemandRow } from "@/lib/dashboard/finished-stock-demand";
import type { LabState } from "@/lib/lab-state";
import { listOrderLines, listOrders, type OrdersClient } from "@/lib/orders-repository";
import { supabase } from "@/lib/supabase";

const NOT_CONFIGURED: OrdersSnapshot = { status: "unavailable", reason: "not-configured", message: "Orders need a connected database." };

function formatBusinessDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function SectionCard({ children, className = "", label }: { children: React.ReactNode; className?: string; label: string }) {
  return (
    <section aria-label={label} className={`rounded-lg border border-[#e1d4c4] bg-white p-5 ${className}`}>
      {children}
    </section>
  );
}

function SectionHeading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">{children}</h3>
      {hint ? <p className="mt-1 text-sm text-[#6f5a4c]">{hint}</p> : null}
    </div>
  );
}

function ViewAllLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-[#8f5632] hover:underline" href={href}>
      {children} <ArrowRight size={14} />
    </a>
  );
}

// --- Zone 1: business pulse ------------------------------------------------------------------

function PulseCard({ featured, metric }: { featured: boolean; metric: PulseMetric }) {
  return (
    <div className={`rounded-lg border p-4 ${featured ? "border-[#231813] bg-[#231813] text-[#fff8ef]" : "border-[#e1d4c4] bg-white"}`}>
      <p className={`text-sm font-medium ${featured ? "text-[#ddb778]" : "text-[#6f5a4c]"}`}>{metric.label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums sm:text-3xl">{metric.value}</p>
      <p className={`mt-1 text-xs ${featured ? "text-[#d8c6b8]" : "text-[#8a7c6d]"}`}>{metric.detail}</p>
    </div>
  );
}

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

function PulseZone({ model, onRetry }: { model: DashboardModel; onRetry: () => void }) {
  const { selling } = model;

  if (selling.status === "unavailable") {
    return <SellingUnavailable onRetry={onRetry} selling={selling} />;
  }

  if (selling.status === "loading") {
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {selling.pulse.map((metric, index) => (
          <PulseCard featured={index === 0} key={metric.key} metric={metric} />
        ))}
      </div>
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

function pieces(value: number | null): string {
  return value === null ? "—" : String(value);
}

function StockRow({ row }: { row: FinishedStockDemandRow }) {
  const isShort = (row.shortagePieces ?? 0) > 0;
  const cell = "flex items-baseline justify-between gap-1 sm:block sm:text-right";
  const cellLabel = "text-[11px] uppercase tracking-wide text-[#8a7c6d] sm:hidden";
  return (
    <li className="py-3 sm:grid sm:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))] sm:items-center sm:gap-3">
      <p className="font-medium text-[#231813]">{row.productName}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:contents">
        <div className={cell}>
          <dt className={cellLabel}>Available</dt>
          <dd className="font-semibold">{row.availablePieces}</dd>
        </div>
        <div className={cell}>
          <dt className={cellLabel}>Reserved</dt>
          <dd className="text-[#6f5a4c]">{row.reservedPieces}</dd>
        </div>
        <div className={cell}>
          <dt className={cellLabel}>New orders</dt>
          <dd>{pieces(row.unreservedDemandPieces)}</dd>
        </div>
        <div className={cell}>
          <dt className={cellLabel}>Short</dt>
          <dd className={isShort ? "font-semibold text-[#b3441f]" : "text-[#8a7c6d]"}>{isShort ? row.shortagePieces : row.shortagePieces === null ? "—" : "0"}</dd>
        </div>
      </dl>
    </li>
  );
}

function StockZone({ model }: { model: DashboardModel }) {
  const { stock } = model;
  const columnLabel = "text-right text-[11px] font-semibold uppercase tracking-wide text-[#8a7c6d]";

  return (
    <SectionCard label="Finished stock and demand">
      <SectionHeading hint="Pieces ready now, against orders that are new and not yet reserved.">Finished stock &amp; demand</SectionHeading>
      {stock.rows.length === 0 ? (
        <p className="text-sm text-[#6f5a4c]">
          No finished stock and nothing waiting on it. Stock shows up here after a bake. <a className="font-semibold text-[#8f5632] hover:underline" href="/bake">Go to Bake</a>
        </p>
      ) : (
        <>
          <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))] gap-3 border-b border-[#eaded2] pb-2 sm:grid">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[#8a7c6d]">Product</span>
            <span className={columnLabel}>Available</span>
            <span className={columnLabel}>Reserved</span>
            <span className={columnLabel}>New orders</span>
            <span className={columnLabel}>Short</span>
          </div>
          <ul className="divide-y divide-[#f0e6da]">{stock.rows.map((row) => <StockRow key={row.productId} row={row} />)}</ul>
          {!stock.hasDemand ? <p className="mt-2 text-sm text-[#7a5b33]">New-order demand isn&apos;t available right now, so shortages can&apos;t be shown.</p> : null}
          {stock.uncheckedLines ? (
            <p className="mt-2 text-xs text-[#8a6d4f]">
              {stock.uncheckedLines} new-order {plural(stock.uncheckedLines, "line has", "lines have")} no recorded pack size, so {plural(stock.uncheckedLines, "it isn't", "they aren't")} counted above.
            </p>
          ) : null}
        </>
      )}
      {stock.hiddenCount > 0 ? <p className="mt-2 text-sm text-[#6f5a4c]">+{stock.hiddenCount} more {plural(stock.hiddenCount, "product", "products")}</p> : null}
      <ViewAllLink href="/bake">Open Bake</ViewAllLink>
    </SectionCard>
  );
}

// --- Zone 4: inventory attention -------------------------------------------------------------

function reasonLabel(reason: InventoryExceptionReason): { text: string; tone: "danger" | "warn" } {
  if (reason.kind === "stock") {
    return reason.status === "out" ? { text: "Out of stock", tone: "danger" } : { text: "Low", tone: "warn" };
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

  return (
    <DashboardView hasIngredients={labState.ingredients.length > 0} message={message} messageTone={messageTone} model={model} onRefresh={refresh} />
  );
}

// Presentational: renders a finished model and nothing else.
export function DashboardView({
  hasIngredients,
  message,
  messageTone,
  model,
  onRefresh,
}: {
  hasIngredients: boolean;
  message: string;
  messageTone: "good" | "bad" | "info";
  model: DashboardModel;
  onRefresh: () => void;
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
      {/* DOM order is the mobile order (attention, pulse, stock, inventory). From xl the same four
          zones are re-seated: pulse across the top, then attention over stock on the left with
          inventory down the right. */}
      <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] xl:items-start">
        <div className="xl:order-2">
          <AttentionZone model={model} />
        </div>
        <div className="xl:order-1 xl:col-span-2">
          <PulseZone model={model} onRetry={onRefresh} />
        </div>
        <div className="xl:order-4">
          <StockZone model={model} />
        </div>
        <div className="xl:order-3 xl:row-span-2">
          <InventoryZone hasIngredients={hasIngredients} model={model} />
        </div>
      </div>
    </div>
  );
}
