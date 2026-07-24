# ROADMAP

> Human-approved work only. Triage never writes here — `planning/PROPOSALS.md` does, and you
> promote from there.

## Approved backlog

*Empty.*

## Ideas

*Empty.*

## Research

*Empty.*

## Known issues

- **No structured experiment-scheduling data.** `scripts/daily-advisor/portfolio-ranking.ts`'s
  `getExperimentSignal()` (Daily AI Advisor, see `DAILY_AI_ADVISOR.md`) can only report whether a
  product's latest batch is unsettled (`launchDecision: "retest"`) or has zero tasting feedback
  recorded -- it can never say an observation is "due" or "overdue" because no due-date field
  exists anywhere in `ProductBatch`/`TastingFeedback`. Rule Engine's DEV-004 has the identical gap
  (`docs/ARCHITECTURE.md`'s "Data gaps" section). If real due-date tracking is ever wanted, add
  structured fields -- e.g. `experimentStatus` and `nextObservationAt` on `ProductBatch` (or a
  dedicated `experiments` table) -- rather than inferring a cadence from free text. Logged here
  instead of built silently; no schema change was made as part of the Daily AI Advisor work.

## Do not work on

*Empty. Add things here when you decide NOT to do them — it stops agents re-proposing them
every triage run.*
