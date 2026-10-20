// Reporting periods. Every financial date is a Manila business day (BUSINESS_TIMEZONE), resolved
// through business-day.ts -- never getToday(), which is UTC and would put the first eight hours of
// every Manila day (and so the first eight hours of every month) in the wrong period.

import { BUSINESS_TIMEZONE, resolveBusinessDay } from "../business-day.ts";
import type { BusinessDayRange } from "../orders/revenue.ts";

// Provisional: expenses were not recorded before this month, and opening balances have not been
// verified. A month before it can still be viewed, but no operating result is ever computed for it.
// The owner moves this when the accounting start is formally confirmed.
export const FINANCIAL_REPORTING_START_MONTH = "2026-10";

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_KEY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isMonthKey(value: string): boolean {
  return MONTH_KEY.test(value);
}

// The Manila month a timestamp falls in, or null for a missing/unparseable timestamp (never "now").
export function monthKeyOfTimestamp(timestamp: string | null, timeZone: string = BUSINESS_TIMEZONE): string | null {
  if (!timestamp) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return resolveBusinessDay(parsed, timeZone).slice(0, 7);
}

// A calendar date column (YYYY-MM-DD) already IS a business day; it is not shifted by a timezone.
export function monthKeyOfDay(day: string): string | null {
  return DAY_KEY.test(day) ? day.slice(0, 7) : null;
}

export function currentMonthKey(nowMs: number, timeZone: string = BUSINESS_TIMEZONE): string {
  return resolveBusinessDay(nowMs, timeZone).slice(0, 7);
}

export function monthRange(month: string, timeZone: string = BUSINESS_TIMEZONE): BusinessDayRange {
  const match = MONTH_KEY.exec(month);
  if (!match) {
    throw new Error(`Not a month key: ${month}`);
  }
  const lastDay = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return { fromDay: `${month}-01`, toDay: `${month}-${String(lastDay).padStart(2, "0")}`, timezone: timeZone };
}

export function shiftMonth(month: string, delta: number): string {
  const match = MONTH_KEY.exec(month);
  if (!match) {
    throw new Error(`Not a month key: ${month}`);
  }
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Newest first, from `current` back to `earliest` inclusive (at least `current` itself).
export function listMonths(earliest: string, current: string): string[] {
  const months: string[] = [];
  for (let month = current; month >= earliest && months.length < 120; month = shiftMonth(month, -1)) {
    months.push(month);
  }
  return months.length > 0 ? months : [current];
}

export function daysBetweenDays(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split("-").map(Number);
  const [ty, tm, td] = toDay.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}
