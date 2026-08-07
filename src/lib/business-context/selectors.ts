import type { BusinessContext, Signal } from "./types.ts";

// Named pure accessors over an already-built BusinessContext.
//
// Not a layer, not a schema, not a stage -- the answer to "every consumer needs the same definition
// of *the blockers*, and none of them should re-derive it". Dashboards, alerts, reports, and the AI
// all call the same function instead of each writing their own filter.
//
// This is deliberately what a BusinessState object would have been, minus everything that made a
// state object a bad idea:
//
//   - Nothing to version. A selector *is* the single definition, so it cannot drift from itself.
//   - Nothing to invalidate. Computed at call time from the snapshot in hand, then discarded.
//   - Nothing to persist. Selector output appears in no context, no view, no manifest, no digest.
//   - Nothing that can disagree with the facts. Selectors return references into the context, so
//     there is no parallel summary to fall out of sync with its source.
//
// M1 ships exactly one selector. The rest of the library (getSignalsByDomain, getInsufficientData,
// getRankedFindings, getContextQuality) is deliberately deferred -- and getRankedFindings in
// particular is a later, separate piece of work, since ranking is a view concern that must carry a
// named, versioned comparator rather than an ad-hoc sort.

// Every signal that is a known, active failure at blocker severity, drawn from both homes: each
// domain's own signals and the cross-domain signals composed onto the envelope.
//
// `status: "insufficient_data"` is excluded even at blocker severity, and that exclusion is the
// interesting part. A blocker we could not evaluate is not a blocker we found -- reporting it as
// one would turn "we did not look" into "the business is broken", which is precisely the
// laundering this architecture exists to prevent. Such signals stay visible in the context and
// belong to a separate accessor when one is needed.
//
// Returns references, never copies: the objects handed back are the same ones the context holds.
// Order follows the context's own iteration (domain signals in registry order, then cross-domain);
// no sorting is applied, because ranking belongs to a view with a named comparator.
export function getBlockers(context: BusinessContext): Signal[] {
  const isBlocker = (signal: Signal) => signal.severity === "blocker" && signal.status === "fail";

  const domainBlockers = Object.values(context.domains)
    .filter((domain) => domain !== undefined)
    .flatMap((domain) => domain.signals.filter(isBlocker));

  return [...domainBlockers, ...context.signals.filter(isBlocker)];
}
