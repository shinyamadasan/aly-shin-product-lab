// Finished Stock & Demand -- shared, verbatim, between the Dashboard (a capped 5-row glance) and
// the Orders workspace (the full list). Both read the exact same buildFinishedStockDemand output
// through sliceFinishedStockDemandRows (src/lib/dashboard/finished-stock-demand.ts); this file only
// renders whatever shape it is handed. A later calculation fix only ever touches that one function.

import { SectionCard, SectionHeading, ViewAllLink } from "@/components/ui";
import type { FinishedStockDemandRow, FinishedStockDemandSectionData } from "@/lib/dashboard/finished-stock-demand";

function pieces(value: number | null): string {
  return value === null ? "—" : String(value);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function StockRow({ row }: { row: FinishedStockDemandRow }) {
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

export function FinishedStockDemandSection({ section }: { section: FinishedStockDemandSectionData }) {
  const columnLabel = "text-right text-[11px] font-semibold uppercase tracking-wide text-[#8a7c6d]";

  return (
    <SectionCard label="Finished stock and demand">
      {/* Hidden below lg to save vertical space on mobile -- the card's own content (product rows,
          Open Bake) is self-explanatory without repeating the section name and a description above
          it; aria-label on SectionCard above still names the section for assistive tech either way.
          Unchanged at >=lg (Dashboard and Orders both). */}
      <div className="hidden lg:block">
        <SectionHeading hint="Pieces ready now, against orders that are new and not yet reserved.">Finished stock &amp; demand</SectionHeading>
      </div>
      {section.rows.length === 0 ? (
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
          <ul className="divide-y divide-[#f0e6da]">{section.rows.map((row) => <StockRow key={row.productId} row={row} />)}</ul>
          {!section.hasDemand ? <p className="mt-2 text-sm text-[#7a5b33]">New-order demand isn&apos;t available right now, so shortages can&apos;t be shown.</p> : null}
          {section.uncheckedLines ? (
            <p className="mt-2 text-xs text-[#8a6d4f]">
              {section.uncheckedLines} new-order {plural(section.uncheckedLines, "line has", "lines have")} no recorded pack size, so {plural(section.uncheckedLines, "it isn't", "they aren't")} counted above.
            </p>
          ) : null}
        </>
      )}
      {section.hiddenCount > 0 ? <p className="mt-2 text-sm text-[#6f5a4c]">+{section.hiddenCount} more {plural(section.hiddenCount, "product", "products")}</p> : null}
      <ViewAllLink href="/bake">Open Bake</ViewAllLink>
    </SectionCard>
  );
}
