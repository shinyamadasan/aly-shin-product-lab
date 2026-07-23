# PROPOSALS

> Triage output, awaiting human approval. **Nothing here is approved to build.**
> You approve items into `planning/ROADMAP.md` / `planning/BUILD_QUEUE.md` — UNLESS a proposal's own
> `▶ Decision` is Approve and its own `▶ Risk` is Low, in which case it promotes itself straight to
> `planning/BUILD_QUEUE.md` with no reply needed (D-042). Everything else still waits for you.

*No proposals yet.*

## Proposal contract
*(the structured shape triage produces — keep this shape so downstream stages stay swappable)*
```
### PROP-NNN — <title>
- ▶ Decision: Approve | Park | Reject | Clarify — <one-line why; the recommended next action, stated first>
- ▶ Risk: Low | High — <one-line why. Low = reversible (UI, copy, additive non-data features). High =
  touches data/sync/storage, auth, security, or the AI Dev OS/automation itself (adapt this to your
  own app's actual red-zone surface once CLAUDE.md's Hard Rules are filled in) — the same D-032
  red-zone list, applied here at idea time instead of at merge time. When genuinely unsure, say
  High — the tie-break favors asking.>
- type:        feature | bug | chore | decision
- source captures: <ids> (×N duplicates)
- goal alignment:  supports | conflicts | mixed | neutral  — vs the Current Objective (name it; add which North-star goal)
- expected user value: <who benefits, how much, in the current phase>
- evidence:    <recurring friction · dup count · roadmap/similar-past alignment · demand signal>
- effort:      S | M | L
- dependencies: <none | …>
- confidence:  high | med | low
- ambiguity:   <none | what's unclear>
- why now vs later: <why it belongs in the next sprint, or why it should wait>
- AI-recommended priority: P0..P3   (goal-adjusted, not raw priority)
- status:      pending
```
*`▶ Decision` is the recommended action; `status` is your recorded outcome. They differ on purpose —
the AI recommends, you decide, UNLESS Decision is Approve and Risk is Low, in which case the decision
is made mechanically (D-042) and `status` goes straight to `approved` without waiting for a reply.*
**Approve** = build it (→ ROADMAP). **Park** = valid, not now. **Reject** = drop it. **Clarify** = AI
can't recommend confidently; it needs an answer from you first.
