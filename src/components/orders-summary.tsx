"use client";

// S7 PR-G2: the Selling operational readout, rendered.
//
// Presentational only. It receives a finished SellingSummary and formats it. Every inclusion rule,
// window, and money definition was decided in src/lib/orders/summary.ts (PR-G1) and none of them is
// reproduced, second-guessed, or adjusted here.
//
// That boundary is the point of the slice, so it is enforced rather than intended: this file imports
// no revenue.ts, no pieces.ts, no attribution.ts, no fulfillment.ts, no repository and no Supabase
// client, and it never receives a raw Order[] it could compute from. A structural test asserts all of
// it. If this component ever needs an order array to answer a question, the question belongs in
// summary.ts.
//
// It also reads no clock. `businessDay` and the week range arrive already resolved from the
// observation time of the loaded data, so the panel cannot drift from the list beside it.

import { CalendarClock, ClipboardList, Package, Sparkles } from "lucide-react";
import { toDisplayPrice } from "@/lib/orders/money";
import type { SellingSummary } from "@/lib/orders/summary";

function peso(value: number): string {
  return `₱${toDisplayPrice(value)}`;
}

// Matches the label rule the order list already applies to the same values, so the two surfaces
// never disagree about how a channel is written.
function sourceLabel(source: string): string {
  return source === "unknown" ? "Unknown source" : source.replace(/_/g, " ");
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function SectionHeading({ children, icon }: { children: React.ReactNode; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[#8f5632]">
      {icon}
      <h4 className="text-xs font-semibold uppercase tracking-[0.14em]">{children}</h4>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-[#e1d4c4] bg-white p-4">{children}</div>;
}

// One attention line. Rendered only when `count` is non-zero -- a column of zeroes is noise, and an
// operator scanning for what needs doing should see only what needs doing.
function AttentionRow({ count, label, value }: { count: number; label: string; value?: string }) {
  if (count === 0) {
    return null;
  }
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1">
      <span className="text-sm text-[#5f4a3d]">
        <span className="mr-2 inline-block min-w-6 text-base font-semibold tabular-nums text-[#231813]">{count}</span>
        {label}
      </span>
      {value ? <span className="text-sm font-semibold tabular-nums text-[#231813]">{value}</span> : null}
    </li>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-sm text-[#6f5a4c]">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-[#231813]">{value}</span>
    </div>
  );
}

// Refund and net lines appear only when money actually went back. Showing "₱0.00 refunded" on every
// ordinary day would add two rows that are almost always noise, and would quietly train the operator
// to stop reading the block.
function RevenueLines({ gross, refunds, net }: { gross: number; refunds: number; net: number }) {
  return (
    <>
      <Figure label="Paid revenue" value={peso(gross)} />
      {refunds > 0 ? (
        <>
          <Figure label="Refunded" value={`−${peso(refunds)}`} />
          <Figure label="Net revenue" value={peso(net)} />
        </>
      ) : null}
    </>
  );
}

// The pack-size disclosure. `pieces` is a FLOOR whenever any line's snapshot is missing, so it is
// never presented as a total: "18 known pieces + 1 line with unknown pack size". Guessing the
// missing size -- as 1, or as the product's current format -- would invent the one number the
// snapshot column exists to keep honest.
function PiecesText({ pieces, unknownLines }: { pieces: number; unknownLines: number }) {
  if (unknownLines === 0) {
    return <>{pieces} {plural(pieces, "piece", "pieces")}</>;
  }
  const unknownText = `${unknownLines} ${plural(unknownLines, "line", "lines")} with unknown pack size`;
  if (pieces === 0) {
    return <span className="text-[#8a6d4f]">pack size unknown ({unknownText})</span>;
  }
  return (
    <>
      {pieces} known {plural(pieces, "piece", "pieces")} <span className="text-[#8a6d4f]">+ {unknownText}</span>
    </>
  );
}

export function OrdersSummary({ summary }: { summary: SellingSummary }) {
  const { attention, today, week, toPrepareToday, mostOrdered, sources } = summary;

  const attentionTotal =
    attention.newAwaitingConfirmation + attention.needsScheduling + attention.readyForHandover + attention.unpaidCount + attention.overdueHandovers;

  return (
    <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3" id="orders-summary">
      <Card>
        <SectionHeading icon={<Sparkles size={14} />}>Needs attention</SectionHeading>
        {attentionTotal === 0 ? (
          // A plain statement of fact, not advice. S7 reports; it does not recommend.
          <p className="mt-3 text-sm leading-6 text-[#6f5a4c]">Nothing needs attention.</p>
        ) : (
          <ul className="mt-2 divide-y divide-[#f0e6da]">
            <AttentionRow count={attention.newAwaitingConfirmation} label={`new ${plural(attention.newAwaitingConfirmation, "order", "orders")} awaiting confirmation`} />
            <AttentionRow count={attention.needsScheduling} label={`confirmed ${plural(attention.needsScheduling, "order needs", "orders need")} scheduling`} />
            <AttentionRow count={attention.readyForHandover} label="ready for handover" />
            <AttentionRow count={attention.unpaidCount} label="unpaid" value={peso(attention.unpaidValue)} />
            <AttentionRow count={attention.overdueHandovers} label={`overdue ${plural(attention.overdueHandovers, "handover", "handovers")}`} />
          </ul>
        )}
      </Card>

      <Card>
        <SectionHeading icon={<CalendarClock size={14} />}>Today</SectionHeading>
        <p className="mt-1 text-xs text-[#8a7c6d]">{today.businessDay} · Manila</p>
        <div className="mt-2 divide-y divide-[#f0e6da]">
          <Figure label="Orders placed" value={String(today.ordersPlaced)} />
          <Figure label="Remaining handovers" value={String(today.remainingHandovers)} />
          <RevenueLines gross={today.grossRevenue} net={today.netRevenue} refunds={today.refunds} />
        </div>
      </Card>

      <Card>
        <SectionHeading icon={<CalendarClock size={14} />}>Last 7 days</SectionHeading>
        {/* Named as a rolling window, never "this week": it always ends today and always spans seven
            days, so it neither resets on a Monday nor lines up with a calendar week. */}
        <p className="mt-1 text-xs text-[#8a7c6d]">Rolling 7 days · {week.range.fromDay} to {week.range.toDay}</p>
        <div className="mt-2 divide-y divide-[#f0e6da]">
          <Figure label="Orders placed" value={String(week.ordersPlaced)} />
          <RevenueLines gross={week.grossRevenue} net={week.netRevenue} refunds={week.refunds} />
        </div>
      </Card>

      <Card>
        <SectionHeading icon={<Package size={14} />}>To prepare today</SectionHeading>
        {toPrepareToday.groups.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-[#6f5a4c]">Nothing scheduled to prepare today.</p>
        ) : (
          <ul className="mt-2 divide-y divide-[#f0e6da]">
            {/* Keyed by the summary's own group key, which is never shown -- an operator has no use
                for "product:" or "manual:", and the catalog/manual distinction is deliberately not
                surfaced as a badge. */}
            {toPrepareToday.groups.map((group) => (
              <li className="py-1.5" key={group.key}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-sm font-medium text-[#231813]">{group.label}</span>
                  <span className="text-sm tabular-nums text-[#5f4a3d]">{group.units} {plural(group.units, "unit", "units")}</span>
                </div>
                <p className="text-xs text-[#6f5a4c]">
                  <PiecesText pieces={group.pieces} unknownLines={group.piecesUnknownLines} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <SectionHeading icon={<ClipboardList size={14} />}>Most ordered · last 7 days</SectionHeading>
        {mostOrdered.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-[#6f5a4c]">Nothing ordered in the last 7 days.</p>
        ) : (
          <>
            <ul className="mt-2 divide-y divide-[#f0e6da]">
              {mostOrdered.map((item) => (
                <li className="flex flex-wrap items-baseline justify-between gap-x-3 py-1" key={item.key}>
                  <span className="text-sm text-[#231813]">{item.label}</span>
                  <span className="text-sm font-semibold tabular-nums text-[#5f4a3d]">{item.units} selling {plural(item.units, "unit", "units")}</span>
                </li>
              ))}
            </ul>
            {/* The basis is stated, not implied. Ranked by units sold -- not by revenue, pieces, or
                margin, none of which this number measures. */}
            <p className="mt-2 text-xs leading-5 text-[#8a7c6d]">Ranked by selling units, not revenue.</p>
          </>
        )}
      </Card>

      <Card>
        <SectionHeading icon={<ClipboardList size={14} />}>Sources · last 7 days</SectionHeading>
        {sources.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-[#6f5a4c]">No orders in the last 7 days.</p>
        ) : (
          // Rendered in the order the summary produced. Re-sorting here would create a second
          // ordering rule that could disagree with the one attribution.ts already applies, which
          // deliberately keeps "Unknown source" visible and last.
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {sources.map((entry) => (
              <li className="text-sm text-[#5f4a3d]" key={entry.source}>
                <span className="capitalize">{sourceLabel(entry.source)}</span> <span className="font-semibold tabular-nums text-[#231813]">{entry.count}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
