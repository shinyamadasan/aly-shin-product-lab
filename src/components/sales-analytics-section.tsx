"use client";

// Orders Workspace V1.1: Dashboard's selectable-period Sales Analytics, rendered.
//
// Ported from Orders Workspace V1's orders-summary.tsx, not duplicated: the period picker, the four
// metrics, Most Ordered and Sources answer "how is the business doing" -- a Dashboard question, not
// an "what do I need to do right now" Orders one. This file owns none of that math; it receives a
// finished SalesPeriodOverview (src/lib/orders/summary.ts) and formats it, same presentational
// boundary V1 already proved: no revenue.ts, no pieces.ts, no attribution.ts, no repository, no
// Supabase client, no raw Order[]. The one exception is trivial custom-date-range input validation
// (non-empty, start <= end) -- native <input type="date"> only ever yields "" or a well-formed
// YYYY-MM-DD, so this is UI-input hygiene, not a restatement of resolveSalesPeriodRange's own
// (defensive-only) fallback rule.
//
// Unpaid is rendered here too, but reads its own two props (unpaidValue/unpaidCount, sourced from
// the unchanged SellingSummary.attention fields) rather than anything on `overview` -- it represents
// current outstanding money, not historical period performance, and must never move when the
// operator changes the selected period. It is visually its own card for exactly that reason.

import { useState } from "react";
import { SectionCard, SectionHeading } from "@/components/ui";
import { toDisplayPrice } from "@/lib/orders/money";
import type { SalesPeriodKey, SalesPeriodOverview, SalesPeriodSelection } from "@/lib/orders/summary";

function peso(value: number): string {
  return `₱${toDisplayPrice(value)}`;
}

// Matches the label rule the order list already applies to the same values, so the two surfaces
// never disagree about how a channel is written.
function sourceLabel(source: string): string {
  return source === "unknown" ? "Unknown source" : source.replace(/_/g, " ");
}

// Same plain convention as sourceLabel above (no per-brand casing map): a generic "bank_transfer"
// renders as "Bank transfer", never a guessed destination account like "GoTyme" -- this file has no
// data that identifies which bank or e-wallet a transfer landed in, and does not invent one.
function paymentMethodLabel(method: string): string {
  return method === "unknown" ? "Unknown" : method.replace(/_/g, " ");
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
      <p className="text-xs text-[#6f5a4c]">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-[#231813]">{value}</p>
    </div>
  );
}

const salesPeriodOptions: Array<{ key: SalesPeriodKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "last7", label: "Last 7 days" },
  { key: "last30", label: "Last 30 days" },
  { key: "thisMonth", label: "This month" },
  { key: "allTime", label: "All time" },
  { key: "custom", label: "Custom range" },
];

// A non-empty, start<=end pair -- the only shape a native <input type="date"> can ever produce
// besides "", so this is input hygiene, not a re-derivation of what a valid business-day range is.
function isUsableCustomRange(startDay: string, endDay: string): boolean {
  return startDay !== "" && endDay !== "" && startDay <= endDay;
}

function SalesPeriodPicker({
  overview,
  period,
  onPeriodChange,
}: {
  overview: SalesPeriodOverview;
  period: SalesPeriodSelection;
  onPeriodChange: (next: SalesPeriodSelection) => void;
}) {
  // Local drafts for the two date inputs -- seeded from whatever range is currently showing, so
  // switching into Custom never starts from a blank, unusable pair. Only propagated upward once the
  // pair is a usable range; an in-progress edit (e.g. start typed, end not yet) stays local.
  const [customStart, setCustomStart] = useState(period.kind === "custom" ? period.startDay : overview.range.fromDay);
  const [customEnd, setCustomEnd] = useState(period.kind === "custom" ? period.endDay : overview.range.toDay);
  const showError = !isUsableCustomRange(customStart, customEnd);

  function handleKindChange(kind: SalesPeriodKey) {
    if (kind !== "custom") {
      onPeriodChange({ kind });
      return;
    }
    if (isUsableCustomRange(customStart, customEnd)) {
      onPeriodChange({ kind: "custom", startDay: customStart, endDay: customEnd });
    }
    // An unusable draft stays local and visibly flagged (showError) rather than propagating -- the
    // operator sees the inputs they're mid-editing, not a silently-substituted period.
  }

  function handleCustomChange(nextStart: string, nextEnd: string) {
    setCustomStart(nextStart);
    setCustomEnd(nextEnd);
    if (isUsableCustomRange(nextStart, nextEnd)) {
      onPeriodChange({ kind: "custom", startDay: nextStart, endDay: nextEnd });
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-xs font-medium">
        Period
        <select
          className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm"
          onChange={(event) => handleKindChange(event.target.value as SalesPeriodKey)}
          value={period.kind}
        >
          {salesPeriodOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
      </label>
      {period.kind === "custom" ? (
        <>
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium sm:w-auto sm:flex-none">
            Start date
            <input
              className="h-9 w-full min-w-0 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm sm:w-auto"
              onChange={(event) => handleCustomChange(event.target.value, customEnd)}
              type="date"
              value={customStart}
            />
          </label>
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium sm:w-auto sm:flex-none">
            End date
            <input
              className="h-9 w-full min-w-0 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm sm:w-auto"
              onChange={(event) => handleCustomChange(customStart, event.target.value)}
              type="date"
              value={customEnd}
            />
          </label>
          {showError ? <p className="w-full text-xs text-[#b3441f]">Enter a start and end date, start on or before end.</p> : null}
        </>
      ) : null}
    </div>
  );
}

// Mobile Operational Compression V1, Part E: the collapsed "Business performance" disclosure's one
// live snapshot line, built from the CURRENT selection/overview -- never a hardcoded "Last 7 days".
// Reuses the same salesPeriodOptions labels the picker itself uses; falls back to the raw range for
// a custom selection, which has no preset label.
export function collapsedBusinessPerformanceSummary(period: SalesPeriodSelection, overview: SalesPeriodOverview): string {
  const preset = salesPeriodOptions.find((option) => option.key === period.kind);
  const rangeLabel = preset && period.kind !== "custom" ? preset.label : `${overview.range.fromDay} to ${overview.range.toDay}`;
  return `${rangeLabel} · ${peso(overview.paidRevenue)} paid revenue`;
}

export function SalesAnalyticsSection({
  overview,
  period,
  onPeriodChange,
  unpaidValue,
  unpaidCount,
  showUnpaid = true,
  compactRangeCaptions = false,
}: {
  overview: SalesPeriodOverview;
  period: SalesPeriodSelection;
  onPeriodChange: (next: SalesPeriodSelection) => void;
  unpaidValue: number;
  unpaidCount: number;
  // Mobile Operational Compression V1: Dashboard's mobile tree surfaces Unpaid separately (folded
  // into the combined Needs Attention area when positive, per Part B3), so it passes false here to
  // avoid rendering the same figure twice inside the collapsed Business Performance disclosure.
  // Desktop's one call site omits this -- unaffected, still true.
  showUnpaid?: boolean;
  // Part E1: on mobile, the selected range is already visible once at the top of this card, so the
  // populated-state captions under Most ordered/Sources/Payments received drop their own repeat of
  // it. The empty-state sentences keep the range regardless (removing it there would leave an
  // ambiguous, scope-less sentence). Desktop's one call site omits this -- unaffected, still false.
  compactRangeCaptions?: boolean;
}) {
  const rangeCaption = `${overview.range.fromDay} to ${overview.range.toDay}`;

  return (
    <div className="space-y-4">
      {/* Current outstanding money, not historical period performance -- its own card, on purpose,
          so it never reads as though the period picker below controls it. */}
      {showUnpaid ? (
        <SectionCard label="Unpaid">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <SectionHeading>Unpaid</SectionHeading>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-[#231813]">{peso(unpaidValue)}</p>
            </div>
            <p className="text-sm text-[#6f5a4c]">{unpaidCount} {plural(unpaidCount, "order", "orders")} owing</p>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard label="Sales analytics">
        <SectionHeading>Sales overview</SectionHeading>
        <div className="mt-2">
          <SalesPeriodPicker onPeriodChange={onPeriodChange} overview={overview} period={period} />
        </div>
        <p className="mt-2 text-xs text-[#8a7c6d]">{rangeCaption}</p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Orders placed" value={String(overview.ordersPlaced)} />
          <Metric label="Selling units" value={String(overview.sellingUnits)} />
          <Metric label="Paid revenue" value={peso(overview.paidRevenue)} />
          <Metric label="Avg order value" value={peso(overview.averagePaidOrderValue)} />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <SectionHeading>Most ordered</SectionHeading>
            {overview.mostOrdered.length === 0 ? (
              <p className="mt-3 text-sm leading-6 text-[#6f5a4c]">Nothing ordered {rangeCaption}.</p>
            ) : (
              <>
                <ul className="mt-2 divide-y divide-[#f0e6da]">
                  {overview.mostOrdered.map((item) => (
                    <li className="flex flex-wrap items-baseline justify-between gap-x-3 py-1" key={item.key}>
                      <span className="text-sm text-[#231813]">{item.label}</span>
                      <span className="text-sm font-semibold tabular-nums text-[#5f4a3d]">{item.units} selling {plural(item.units, "unit", "units")}</span>
                    </li>
                  ))}
                </ul>
                {/* The basis is stated, not implied. Ranked by units sold -- not by revenue, pieces,
                    or margin, none of which this number measures. */}
                <p className="mt-2 text-xs leading-5 text-[#8a7c6d]">Ranked by selling units, not revenue{compactRangeCaptions ? "" : ` · ${rangeCaption}`}</p>
              </>
            )}
          </div>

          <div>
            <SectionHeading>Sources</SectionHeading>
            {overview.sources.length === 0 ? (
              <p className="mt-3 text-sm leading-6 text-[#6f5a4c]">No orders {rangeCaption}.</p>
            ) : (
              // Rendered in the order the overview produced. Re-sorting here would create a second
              // ordering rule that could disagree with the one attribution.ts already applies, which
              // deliberately keeps "Unknown source" visible and last.
              <>
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {overview.sources.map((entry) => (
                    <li className="text-sm text-[#5f4a3d]" key={entry.source}>
                      <span className="capitalize">{sourceLabel(entry.source)}</span> <span className="font-semibold tabular-nums text-[#231813]">{entry.count}</span>
                    </li>
                  ))}
                </ul>
                {compactRangeCaptions ? null : <p className="mt-2 text-xs leading-5 text-[#8a7c6d]">{rangeCaption}</p>}
              </>
            )}
          </div>

          <div>
            <SectionHeading>Payments received</SectionHeading>
            {overview.paymentMethodBreakdown.length === 0 ? (
              <p className="mt-3 text-sm leading-6 text-[#6f5a4c]">No payments received {rangeCaption}.</p>
            ) : (
              // Rendered in the order getPaymentMethodBreakdown produced -- same "no second ordering
              // rule" discipline as Sources above.
              <>
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {overview.paymentMethodBreakdown.map((entry) => (
                    <li className="text-sm text-[#5f4a3d]" key={entry.method}>
                      <span className="capitalize">{paymentMethodLabel(entry.method)}</span> <span className="font-semibold tabular-nums text-[#231813]">{peso(entry.amount)}</span>
                    </li>
                  ))}
                </ul>
                {compactRangeCaptions ? null : <p className="mt-2 text-xs leading-5 text-[#8a7c6d]">{rangeCaption}</p>}
                {/* Gross receipts, not a net balance -- refunds are tracked separately (refundedAt),
                    same as Paid revenue above. Shown only when it would otherwise look surprising:
                    a refunded order in this range whose paidAt still counts here and in Paid revenue. */}
                {overview.hasRefundedPaidOrders ? (
                  <p className="mt-2 text-xs leading-5 text-[#8a7c6d]">Shown as gross receipts; refunds are tracked separately and are not subtracted here.</p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
