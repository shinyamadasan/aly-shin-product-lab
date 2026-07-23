# Commands — the remote-control inbox

The **control-panel** half of the Telegram pipeline, mirroring `captures/decisions/` exactly:
**n8n only ever creates files here** (one immutable file per Telegram control command). It never runs
anything itself. All logic happens later, in `tools/Dispatch-Commands.ps1` on the PC.

```
Telegram command  →  n8n (dumb transport)  →  captures/commands/<id>.md
                                                    │  Dispatch-Commands.ps1 (PC, lock-protected)
                                                    ├─ routes to the matching phase runner
                                                    ├─ marks this file status: applied
                                                    └─ writes captures/replies/<id>-reply.md
```

n8n's job is messaging/transport only. Deciding what a command means and doing it is entirely
PC-side, deterministic routing code — same separation of duties as captures/decisions.

## Command file format (what n8n writes)
Filename: `captures/commands/<UTC-timestamp>-<telegram_msg_id>-command.md`

```markdown
---
id: 20260704T2100Z-99-command
kind: command
command: build
captured: 2026-07-04T21:00:00Z
via: telegram
msg_id: 99
status: new
---

/build
```

## Recognized commands

| command | what it does | mutates repo? |
|---|---|---|
| `/status` | Reports automation state, branch, last run, Codex-ready + review-ready counts | no |
| `/run` | Runs Claude's planning pipeline now (Triage + BUILD_QUEUE→TASKS.md), same as `run-claude.ps1` without `-Scheduled` | yes (`main`) |
| `/build` | Builds the first `status: codex` task in `TASKS.md` on its own `task-<id>` branch | yes (`task-<id>` only, never `main`) |
| `/review` | Reviews the first `status: review` task's branch, writes `REVIEW.md`/`TASKS.md` | yes (`task-<id>` only, never `main`) |
| `/next` | Reports whose turn it is (same table as the interactive `Next` command) | no |
| `/stop` | Kill switch: disables automation, signals any in-progress run to stop | yes (flag only, `main`) |
| `/enable` | Enables automation | yes (flag only, `main`) |
| `/disable` | Disables automation (does not interrupt an in-progress run) | yes (flag only, `main`) |

## Manual dispatcher commands

If Telegram says a command is queued but nothing happens, run this from PowerShell to process queued
commands once:

```powershell
cd "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\Dispatch-Commands.ps1"
# macOS: pwsh ./tools/Dispatch-Commands.ps1
```

If the Windows scheduled dispatcher is disabled, run PowerShell as Administrator and re-enable it:

```powershell
cd "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab"
Enable-ScheduledTask -TaskName "Aly & Shin Product Lab Command Dispatcher"
Start-ScheduledTask -TaskName "Aly & Shin Product Lab Command Dispatcher"
```

On macOS, check and kick the `launchd` job:

```bash
launchctl list | grep "com.aidevos.aly-shin-product-lab.dispatcher"
launchctl kickstart -k "gui/$(id -u)/com.aidevos.aly-shin-product-lab.dispatcher"
```

`status: new` → `applied` once processed (idempotent — an n8n retry can't double-dispatch). Every
command produces exactly one reply in `captures/replies/`, regardless of outcome (success, halt, or
"nothing to do").

No command ever merges a `task-<id>` branch into `main` — that stays a manual, human step.
