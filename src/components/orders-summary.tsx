"use client";

// Orders Workspace V1.1: Order operations, rendered.
//
// Presentational only. It receives a finished SellingSummary and formats two operational sections
// from it -- Needs attention, To prepare today. Every inclusion rule, window, and money definition
// was decided in src/lib/orders/summary.ts and none of them is reproduced, second-guessed, or
// adjusted here.
//
// Sales analytics (the selectable reporting period, its four metrics, Most Ordered, Sources) lived
// here in V1 and moved to Dashboard in V1.1 -- see src/components/sales-analytics-section.tsx.
// Orders answers "what do I need to do right now", not "how is the business doing", so this file no
// longer receives or renders anything period-selectable.
//
// That boundary is the point of the slice, so it is enforced rather than intended: this file imports
// no revenue.ts, no pieces.ts, no attribution.ts, no fulfillment.ts, no repository and no Supabase
// client, and it never receives a raw Order[] it could compute from. A structural test asserts all of
// it. If this component ever needs an order array to answer a question, the question belongs in
// summary.ts.
//
// It also reads no clock. `toPrepareToday` arrives already resolved from the observation time of the
// loaded data, so the panel cannot drift from the list beside it.

import { CheckCircle2, Package, Sparkles } from "lucide-react";
import { toDisplayPrice } from "@/lib/orders/money";
import type { SellingSummary } from "@/lib/orders/summary";

function peso(value: number): string {
  return `₱${toDisplayPrice(value)}`;
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

// Mobile Operational Compression V1, Part A1: healthy/empty = compact, action required = prominent.
// Used only when `compact` is set (below lg) AND the section in question has nothing in it -- the
// moment either section has real content, its existing full Card renders exactly as before.
function CompactStatusRow({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-lg border border-[#e1d4c4] bg-white px-4 py-2.5 text-sm text-[#2e6b44]">
      <CheckCircle2 size={16} /> {children}
    </p>
  );
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

export function OrdersSummary({ compact = false, summary }: { compact?: boolean; summary: SellingSummary }) {
  const { attention, toPrepareToday } = summary;

  const attentionTotal =
    attention.newAwaitingConfirmation + attention.needsScheduling + attention.readyForHandover + attention.unpaidCount + attention.overdueHandovers;
  const isAttentionEmpty = attentionTotal === 0;
  const isPrepareEmpty = toPrepareToday.groups.length === 0;

  // Both healthy: one lightweight operational-status area, not two separate compact rows each
  // claiming their own grid column (explicitly allowed by Part A1).
  if (compact && isAttentionEmpty && isPrepareEmpty) {
    return (
      <div className="grid gap-2" id="orders-summary">
        <CompactStatusRow>Nothing needs attention.</CompactStatusRow>
        <CompactStatusRow>Nothing to prepare today.</CompactStatusRow>
      </div>
    );
  }

  return (
    <section className="grid gap-4 sm:grid-cols-2" id="orders-summary">
      {compact && isAttentionEmpty ? (
        <CompactStatusRow>Nothing needs attention.</CompactStatusRow>
      ) : (
        <Card>
          <SectionHeading icon={<Sparkles size={14} />}>Needs attention</SectionHeading>
          {isAttentionEmpty ? (
            // A plain statement of fact, not advice. This reports; it does not recommend.
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
      )}

      {compact && isPrepareEmpty ? (
        <CompactStatusRow>Nothing to prepare today.</CompactStatusRow>
      ) : (
        <Card>
          <SectionHeading icon={<Package size={14} />}>To prepare today</SectionHeading>
          {isPrepareEmpty ? (
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
      )}
    </section>
  );
}
