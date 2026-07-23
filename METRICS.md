# METRICS — Weekly Engineering Metrics

> A simple weekly log to replace intuition with evidence. After a month you can answer: *Is QA getting
> better? Is Self Review reducing reverts? Is autonomous development actually saving time?*
>
> **Honesty rule (same as QA.md / SELF_REVIEW.md):** every number is tagged by source. **Auto** = an
> agent can compute it from git + the repo files. **Manual** = needs a human signal — don't fabricate;
> leave `—` until you have a real number. Never report a metric you can't actually measure.

## How each metric is sourced
| Metric | Source | Type |
|---|---|---|
| Features shipped | `git log --since feat:` / `planning/DONE.md` | Auto |
| Bugs fixed | `git log --since fix:` | Auto |
| Reverts | `git log --since` reverts | Auto |
| Ideas captured | `captures/processed/**` dated in the week | Auto |
| Ideas implemented | captured items that reached `DONE.md` | Auto |
| Autonomous success rate | runs completing without Blocked ÷ runs (`claude-session.log` / STATUS) | Auto* |
| Bugs escaped QA | bugs found **after** ship (by you or users) | Manual |
| Avg review time | wall-clock per task, if tracked | Manual |

\* approximate from STATUS entries until run-logging exists.

## Week template — copy per week, newest at top
```
## Week of YYYY-MM-DD
- Features shipped: N
- Bugs fixed: N
- Bugs escaped QA: N        (manual)
- Reverts: N
- Autonomous success rate: N%
- Ideas captured: N
- Ideas implemented: N
- Avg review time: —        (manual)
- Notes: <what changed · what to watch next week>
```

*(Auto metrics can be filled by a future `/report` prompt — parked in ROADMAP → Research.)*

---

## Log

_(empty — copy the Week template above once you have a real week to report)_
