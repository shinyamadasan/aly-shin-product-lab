// The business day, resolved in an explicit timezone.
//
// This app currently has two different answers to "what day is it". The workers use
// Asia/Manila (scripts/daily-advisor/run.ts's formatDateInTimezone, ADVISOR_TIMEZONE); the app
// computes UTC (getToday() in src/lib/lab-state.ts, startOfUtcDay() in marketing-advisor-context.ts).
// For a Manila business that difference is not cosmetic -- under UTC the business day rolls over at
// 08:00 local, so "days since", "expires soon", and "was this done today" are all off by one for
// the first eight hours of every working day.
//
// The Business Context Builder resolves the day once, from an injected timezone, and threads it to
// every adapter as BuildEnv.businessDay. No adapter reads a clock, so a snapshot cannot contain two
// disagreeing notions of today.
//
// Deliberately reimplemented here rather than imported from scripts/daily-advisor/run.ts, even
// though that file exports an identical helper: run.ts is a CLI entry point that imports node:path
// and node:util, and importing it from src/ would pull node builtins into the browser bundle.
// Import direction in this repo is scripts/ -> src/, never the reverse. The duplication is two
// lines of Intl and is the cheaper trade.
//
// Correcting the app's own UTC date behaviour is a separate, separately-reviewable change. It is
// deliberately not bundled here, and until it lands the app and the builder will disagree about
// "today" -- harmlessly, because nothing in the app consumes the builder yet.

// en-CA formats as YYYY-MM-DD directly, with no dependency and no manual padding. Node ships full
// ICU from v14 onward, so the timezone database is available without configuration -- the same
// assumption scripts/daily-advisor/run.ts already relies on in production.
export function resolveBusinessDay(nowMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}
