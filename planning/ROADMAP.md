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

- **Production MVP Wave C entry blocker — generated-asset file-size policy is single-valued and
  image-shaped.** `src/lib/asset-generation-validation.ts`'s `GENERATED_ASSET_MAX_FILE_SIZE_BYTES`
  is a single 10 MB ceiling applied to every candidate regardless of asset kind, sized when the only
  kind was a 1080×1080 still. The authored (and deliberately unapplied)
  `supabase-add-generated-assets-video.sql` raises the `generated-assets` bucket to 50 MB for MP4.
  The two therefore disagree: a rendered Reel between 10 MB and 50 MB would be rejected by the
  application validator before Storage ever saw it, and the failure would surface as a candidate
  rejection rather than as the capacity decision it actually is. **Before any `short_video` runtime
  route becomes executable**, Wave C must: implement an explicit per-asset-kind file-size policy;
  validate it against real rendered MP4 sizes rather than estimates; resolve whether Supabase's
  standard upload path suffices at that size or whether resumable/TUS upload is required; and only
  then activate `short_video` execution. Deliberately **not** a Wave A blocker — Wave A neither
  produces nor uploads video, and `EXECUTABLE_ASSET_KINDS` compiler-blocks `short_video` job
  creation until the wave that can honour it. Logged here instead of changing the constant silently:
  the 10 MB limit governs the shipped image path too, so re-sizing it is a Wave C decision made
  against measured video, not a Wave A drive-by.

## Do not work on

*Empty. Add things here when you decide NOT to do them — it stops agents re-proposing them
every triage run.*
