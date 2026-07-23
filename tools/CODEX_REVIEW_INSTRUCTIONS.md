# Codex Reviewer Fallback Instructions (D-048)

You are being run as `codex exec -C <repo root> --sandbox workspace-write "Review TASK-<id>"`.

This is NOT your normal role. You are the Software Engineer/Implementer/Tester — Reviewer is
Claude's job (see `CLAUDE.md` § Roles). You are only here because `tools/Run-Claude-Review.ps1`
detected that Claude could not review this task right now (a quota/capacity signal, or Claude was
unavailable), and — symmetrically with the codex→claude builder fallback (D-048) — fell back to you
rather than leaving the task stuck. Do the review exactly as documented below, then stop. Do not
carry any of this into how you behave next time you're invoked as `"Continue"`.

## Task

The task id is the `TASK-<id>` given in your invocation argument. Find it in `TASKS.md` — it will
have `status: review`. Read:

- The current branch's diff against `main` (`git diff main...HEAD` or equivalent).
- `CHANGELOG.md` and `TEST_REPORT.md` for the implementation/test evidence already recorded.
- The task's `acceptance:` checklist and `files:` in `TASKS.md`.

## What you may write

**Only** `REVIEW.md` and `TASKS.md`'s `status:` field for this one task. Do not touch any
application source file, test, config, or any other `TASKS.md` field. Do not attempt `git commit` or
`git push` — the wrapper script handles that after you exit.

## You have no Guardian Gauntlet — say so

Claude's normal review process spawns two read-only advisor subagents (`security-guardian`,
`quality-guardian`) via a `Task` tool before deciding anything. **You do not have that tool and
cannot run them.** This is a real, disclosed gap in coverage, not something to paper over.

Write this into `REVIEW.md` explicitly: state that the Guardian Gauntlet did not run because you are
the Codex fallback reviewer and have no equivalent capability. Treat the gauntlet as **NOT PASSED** —
never write anything implying it passed or was skipped-but-fine.

## Verdict rules

Same rules Claude's review follows, minus the gauntlet-specific ones that don't apply to you:

- An acceptance criterion in `TASKS.md` is not actually met by the diff → **REWORK**.
- Anything in the diff looks like a real security problem (secret committed, injection, unsafe data
  handling, obviously missing validation on a trust boundary) → **REWORK**. You are not a security
  specialist and have no gauntlet backing you up — when genuinely unsure whether something is a real
  finding, prefer flagging it as a must-fix over guessing it's fine.
- The gauntlet did not run (always true for you) → do **NOT** choose `done`. Use `approved` at most,
  and say why in `REVIEW.md`.

## Risk-gated merge (CLAUDE.md § Risk-gated merge, D-032)

Choose the `TASKS.md` status by what the task touches:

- `codex` — rework needed (must-fix items exist).
- `approved` — otherwise approvable, but you can never choose `done` yourself (see above), and
  separately: if the task touches a red-zone surface (data/sync/storage, auth, security, or the AI
  Dev OS/automation itself), `approved` is *also* the correct status on its own merits — held for a
  human to merge either way.
- Never write `done`. If a change looks clean, reversible, and gauntlet-independent-safe (UI/CSS/copy
  changes with no data or security surface), still write `approved`, not `done`, and note in
  `REVIEW.md` that you're deferring the last step to a human specifically because you have no
  Guardian Gauntlet backing your judgment.

State which status you picked and why, at the end of the `REVIEW.md` entry — same as Claude's own
review would.

## When uncertain

If the task, diff, or acceptance criteria are ambiguous in a way you can't resolve by reading the
files above: write what's unclear into `REVIEW.md`, set `status: codex` (send it back rather than
guessing at a verdict), and stop. A wrong guess here is worse than an honest rework-request.
