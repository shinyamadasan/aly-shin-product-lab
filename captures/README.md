# Captures — mobile capture pipeline

Telegram → n8n → here. **n8n only ever creates files in `inbox/`** (one immutable file per capture).
It never edits planning files. All judgment happens later, in the Claude run's **Triage** event.

```
Telegram  →  n8n (dumb capture)  →  captures/inbox/<id>.md
                                          │  Claude run: Triage
                                          ├─ route → planning/ROADMAP.md (Queue / Known Issues / Ideas / Research)
                                          └─ archive → captures/processed/YYYY/MM/<id>.md
```

## Flow
1. **n8n** writes one file per Telegram message to `inbox/` (see format below). No AI, no parsing of
   planning files — just create the file. The slash command *is* the category.
2. **Claude**, at the start of each run (Triage event in `../WORKFLOW.md`), processes every
   `inbox/*.md`: categorize, **dedupe** against ROADMAP/DONE, **score against the North-star goals in
   `../docs/PROJECT.md`**, estimate priority + complexity, add tags, write acceptance criteria and
   likely-affected files, then **route** the item into `../planning/ROADMAP.md`.
3. Claude then **archives** the processed capture to `processed/YYYY/MM/<id>.md` (immutable history of
   *why* something entered the roadmap) and appends a one-line triage summary to `../STATUS.md`.

`inbox/` should be empty between runs. `processed/` is the permanent provenance log.

## Capture file format (what n8n writes)
Filename: `captures/inbox/<UTC-timestamp>-<telegram_msg_id>-<command>.md`
e.g. `captures/inbox/20260625T1430Z-7842-feature.md`

```markdown
---
id: 20260625T1430Z-7842-feature
command: /feature
type: feature
captured: 2026-06-25T14:30:11Z
via: telegram
msg_id: 7842
status: new
---

Add dark mode.
```

The `id` (timestamp + Telegram `msg_id`) is the **idempotency key**: if the same `id` already appears
in ROADMAP/DONE/processed, Triage skips it (an n8n retry can't create a duplicate task).

## Routing by command
| command | type | routed to | auto-built? |
|---|---|---|---|
| `/feature`, `/todo` | feature / chore | ROADMAP **Task Queue** | yes (FIFO) |
| `/bug` | bug | **Known Issues & Debt** (or Queue if breaking) | if queued |
| `/idea` | idea | **Ideas** (parked) | no |
| `/research` | research | **Research** (parked) | no |
| *(no command)* | unknown | Claude infers at triage | depends |
