# OPERATOR — How You Run the System

> This is the document **you** follow — not Claude, not the automation. You operate an AI engineering
> team now. Your job isn't to write code; it's to keep work flowing: capture inputs, set priority,
> review outputs. Claude executes. You steer.

## Operating Principles
Habits, not commands.

1. **Capture immediately.** The moment an idea or bug appears, send it. An uncaptured thought is a lost one.
2. **Never solve while capturing.** Don't design in the message — that's triage's job. Just name it.
3. **One message = one task.** Two ideas → two messages.
4. **Tasks before ideas.** Draw the queue down before promoting new ideas in.
5. **Ideas stay parked.** `/idea` and `/research` don't build until you promote them. That's the safety valve.
6. **Never interrupt deep work** to "just fix one thing." Capture it, stay in flow.
7. **Review, don't micromanage.** Judge the outcome against the task; don't re-engineer how it was done.

## Daily — it runs from your phone

You do not open the repo to run this system. You open Telegram.

**Morning · ~2 min · the only moment the system truly needs you**

The bot sends the **Morning Digest** (~3 AM, after the overnight run triaged whatever you captured
yesterday). It lists proposals awaiting your judgment. Reply to it:

```
Approve all      Approve 3      Park 5      Reject 2
```

**Nothing is built without this.** Silence means nothing happens — that is the safety valve, not a
bug. Approving is a product decision, and it is the one thing no agent is allowed to do for you.

**Through the day · 0 min**

Idea or bug appears → text the bot → keep going.

```
pantry search is slow on mobile
dark mode toggle in settings
```

Do not triage it. Do not design it in the message. That is what the overnight run is for. **Capture
and continue** — the whole point is that an idea never costs you your flow.

**When you want something shipped · one press**

```
/go
```

One press = **one task, all the way through**: plan → Codex builds on a branch → Guardian Gauntlet
audits it → Claude reviews → merges → deploys. On Windows, a sleeping PC wakes itself to do it; on
macOS, the Mac must stay awake because `launchd` cannot wake it every 30 minutes. Press `/go` again
for the next task.

When `/go` finishes a task cleanly, or when it finds nothing approved/build-ready, the dispatcher
updates `HANDOFF.md` and adds a **Thread reset checkpoint** to the Telegram reply. That is the safe
moment to start a fresh AI thread. Paste the reply's new-thread prompt there; the repo carries the
state, so you do not have to manually summarize the old conversation.

**Evening · ~1 min**

Look at the app. Good → leave it. Wrong → revert the commit. That is the whole review.

**The one thing that is deliberately NOT automatic**

Red-zone work is **HELD**. If a task touches the data / sync / storage layer, auth, security, or the
AI Dev OS itself, the reviewer approves it but does **not** merge — it waits for your eyes
(`status: approved`). A broken UI change is reverted in a minute, but **lost user data cannot be
reverted at all**. See DECISIONS D-032.

You can land it **from the phone**, in two steps (D-036):

```
/merge TASK-014        → shows what it TOUCHES and merges nothing
/merge TASK-014 yes    → runs every gate, then fast-forwards main
```

The first step replies with the files, the diff stat, a GitHub compare link, and — most usefully —
**the reviewer's own recorded reason for holding it**, quoted verbatim. Read that, open the link,
*then* answer.

The gate was never asking you to be at a desk. It was asking you to **look**. `/merge` removes the
desk and keeps the looking: the summary step cannot merge anything, so seeing what a change touches
is unavoidable, while ignoring it stays a deliberate act rather than a reflex.

`/merge TASK-014 yes` is held to exactly the same standard as an auto-merge — clean tree, `npm test`
green, true fast-forward (never a merge commit) — and refuses anything that is not `status:
approved`.

## Weekly (~10 min)
- [ ] **Export your data.** This is the **only real undo for data loss** — `git revert` restores
      code, never deleted rows. Do it before you dogfood anything risky. Set a recurring phone
      reminder; nothing in this system can do it for you.
- [ ] **Merge the held red-zone branches.** Check `TASKS.md` for `status: approved`. From the phone:
      `/merge TASK-014` (read what it touches) then `/merge TASK-014 yes`. At the PC:
      `git checkout main && git merge --ff-only task-<id> && git push origin main`
- [ ] Clean `planning/ROADMAP.md` — reorder the queue, prune what you will never build.
- [ ] Skim `docs/DECISIONS.md` — still agree? Supersede anything that changed.

## Running two or more apps

Same rhythm, once per app: each has its own bot, its own digest, its own `/go`. They share a single
PC wake (the dispatchers are deliberately aligned on the same interval), so the second app costs you
no extra machine time — only the two minutes of judgment its digest asks for.

## At the keyboard (desktop cheat sheet)

Telegram works from the PC too (it just polls every ~2 min). These run the **same phase runners**
instantly. All are lock-protected (`automation.lock`) so they can never overlap each other or the
scheduled run, and **every one takes `-DryRun`** — show what it would do, change nothing.

Open PowerShell and copy-paste a block. On macOS, use `pwsh` and forward slashes.

**Plan / triage** — captures → proposals, approved queue → tasks *(Telegram: `/run`)*
```powershell
cd "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab"
.\run-claude.ps1
# macOS: pwsh ./run-claude.ps1
```

**Build the next `status: codex` task** — auto-chains into review *(Telegram: `/build`; closest thing to `/go` at the PC)*
```powershell
cd "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab"
.\tools\Run-Codex-Build.ps1
# macOS: pwsh ./tools/Run-Codex-Build.ps1
```

**Review the pending `status: review` task** — applies the D-032 risk gate *(Telegram: `/review`)*
```powershell
cd "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab"
.\tools\Run-Claude-Review.ps1
# macOS: pwsh ./tools/Run-Claude-Review.ps1
```

**Merge a held red-zone branch** — a task the reviewer left at `status: approved` (D-032). Replace `<id>`:
```powershell
cd "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab"
git checkout main
git merge --ff-only task-<id>
git push origin main
```

**Process queued Telegram command files** (rarely needed by hand)
```powershell
cd "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab"
.\tools\Dispatch-Commands.ps1
# macOS: pwsh ./tools/Dispatch-Commands.ps1
```

**Options:** all runners take `-DryRun`. The review runner also takes `-NoAutoMerge` (review but never
touch `main` — inspect first) and `-NoPush` (merge locally, don't push).

> **Never run `.\run-claude.ps1 -Scheduled` by hand.** `-Scheduled` is the Windows Task Scheduler
> signal for the scheduled power-management path. Plain `.\run-claude.ps1` or
> `pwsh ./run-claude.ps1` is safe and will not power off or sleep the machine.

## Power model for remote work (D-033)

Windows is set up to **sleep and still work for you**:

| Piece | Setting | Why |
|---|---|---|
| **Command Dispatcher** | Enabled · **WakeToRun = True** · wakes every **30 min** | Wakes the sleeping PC to drain queued Telegram commands (build → review → merge → deploy) |
| **Sleep-after-idle (AC)** | **15 min** *(was: never)* | The PC actually sleeps when you walk away |
| **Claude Overnight** (9 PM / 2 AM) | Wakes PC, then **sleeps** it *(was: `shutdown /s`)* | A powered-**OFF** PC cannot be woken by a timer. Sleep/hibernate can. |
| **Dispatcher keep-awake** | Asserts `ES_SYSTEM_REQUIRED` while working | So a 10–15 min Codex build is never cut in half by the sleep timer |

**The remote loop:** send `/go` from anywhere → n8n writes it into the repo → within **≤30 min** the PC
wakes, builds, reviews, merges (if the D-032 gate says `done`), deploys → goes idle → sleeps again.

**Nothing is lost while asleep.** Commands queue in the repo via GitHub, and `StartWhenAvailable = True`
means the dispatcher drains the whole backlog on the next wake.

**Trade-off:** up to ~30 min latency on a remote command. Irrelevant for work you aren't watching.
Want it snappier? Shorten the interval (more wakes). Want fewer wakes? Lengthen it.

On macOS, the scheduler is `launchd`, not Task Scheduler. macOS has no equivalent to a 30-minute
WakeToRun timer, so the Mac must stay awake for `/go` to run unattended:

```bash
sudo pmset -a sleep 0 displaysleep 10
```

The display can still sleep. The dispatcher also uses `caffeinate` while it is actively building, so
a run is not suspended mid-flight.

### What runs when — and what the master flag actually gates

Every app installed by the AI Dev OS registers **two** schedules. On Windows they are Scheduled
Tasks; on macOS they are `launchd` agents. They do different jobs and are easy to confuse:

| Task | Fires | Job |
|---|---|---|
| **Aly & Shin Product Lab Command Dispatcher** | every **30 min** | Drains Telegram commands (`/status`, `/go`, `/build`, `/review`, `/merge`…) |
| **Aly & Shin Product Lab Claude Overnight** | **9 PM & 2 AM** | Autonomous run: triage captures → proposals → morning digest |

On Windows, both can wake the PC. On macOS, they only fire while the Mac is awake. **Neither is "the
automation" on its own** — they are just alarm clocks.

The thing that decides whether anything actually *happens* is one line in `run-claude.ps1`:

```powershell
$AUTOMATION_ENABLED = $false   # flip to $true once validated
```

That is **the single master flag for everything that mutates the repo unattended** — the overnight
run *and* the dispatcher's build/review/merge commands. It is deliberately not a schedule setting,
because scheduling and permission are different questions:

| | `$AUTOMATION_ENABLED = $false` | `= $true` |
|---|---|---|
| Tasks still fire on schedule | yes | yes |
| `/status`, `/next`, `/log` (read-only) | **work** | work |
| `/go`, `/build`, `/review` (mutating) | **blocked** | run |
| Overnight run does real work | **no — no-ops** | yes |

So a freshly installed app is **fully wired but deliberately inert**. Every alarm is set; nothing is
allowed to touch the repo yet. Turn it on only after you have watched one run:

- `/enable` from Telegram (flips the flag, commits, pushes), or edit `run-claude.ps1` by hand.
- `/disable` is the kill switch — it stops mutation without unregistering anything.

**Validate in this order.** `/status` first: it exercises the whole loop — n8n writes the command
into the repo, the dispatcher wakes and drains it, writes a reply to `captures/replies/OUTBOX.md`,
n8n relays it back to Telegram — while changing nothing. If `/status` replies, the machinery works.
*Then* `/enable`, then `/go`.

### Importing the n8n workflows (read this before you touch n8n)

**Import the JSON files. Never hand-edit the nodes.** Every n8n failure this system has had came from
hand-editing: once it left one app's bot POSTing into another app's repo (both apps fed one repo,
the other went silent, nothing errored), and once it set an HTTP node to `Basic Auth` with empty
headers. The files in the repo are correct by construction — the right repo URL, the right auth
type, the right headers. Editing is how they stop being correct.

Use **Workflows -> ... -> Import from File**, not paste-into-canvas. If you see nodes named
`GitHub: create file1` (note the trailing `1`), you pasted into an existing canvas and now have a
half-old hybrid. Delete it and import properly.

**First, get your numeric Telegram user ID** — several of the workflow JSON files have a
`REPLACE_WITH_YOUR_TELEGRAM_USER_ID` placeholder (it's how the bot knows to only act on messages
from *you*, not a stranger who finds it). Message **@userinfobot** on Telegram (search for it, hit
Start) — it replies instantly with your numeric `Id`. That's the value every placeholder needs.

Two credentials, created once in n8n. For both: click **Credentials** in the left sidebar ->
**Add credential** -> search for the type -> fill in the fields -> **Save**.

**`Telegram Bot - Aly & Shin Product Lab`** (type: **Telegram**) — one field, **Access Token**: paste that
app's bot token (from @BotFather). At the top of the credential, set its own title to
`Telegram Bot - Aly & Shin Product Lab` EXACTLY — that title is what the "Name" in the table below means.

**`GitHub PAT - Aly & Shin Product Lab`** (type: **Header Auth**) — this one has THREE name-like things, and
they are NOT the same thing, which is exactly where this trips people up:
1. The credential's own title (top of the modal, what shows up in your Credentials list) ->
   set this to `GitHub PAT - Aly & Shin Product Lab` EXACTLY.
2. A form field n8n *also* labels **Name** (this is the HTTP header's name, unrelated to #1) ->
   set this to `Authorization`.
3. A form field labeled **Value** (the HTTP header's value) -> set this to
   `Bearer github_pat_...` (your real token, with the literal word `Bearer` and one space before it).

Suffix **both** credential titles with the app name, not just the Telegram one. A bare `GitHub PAT`
looks harmless with one app installed, but the moment a second app's workflow also wants a credential
titled exactly `GitHub PAT`, you can no longer tell them apart in the picker — and the same silent
by-ID mis-binding described below applies to it too.

Recap, so the table matches what's actually in n8n's two different "Name" fields:

| Credential title (#1 above) | Type | Header Name (#2) | Header Value (#3) |
|---|---|---|---|
| `Telegram Bot - Aly & Shin Product Lab` | Telegram | — (just Access Token) | — |
| `GitHub PAT - Aly & Shin Product Lab` | Header Auth | `Authorization` | `Bearer github_pat_...` |

Then, **after** you've imported the 3 workflow files (below), open each Telegram-sending node inside
them and replace `REPLACE_WITH_YOUR_TELEGRAM_USER_ID` with your real numeric ID from @userinfobot,
in that node's own **Chat ID** field. This is filling in a value the workflow already has a slot
for, not restructuring the node — it doesn't conflict with "never hand-edit the nodes" below, which
is about node wiring and auth type, not this one placeholder field every fresh install has to fill.

**THE TRAP: n8n binds credentials by ID, not by name.** The per-app credential names make a
mis-binding *visible*, but they do not *prevent* it — on import, n8n silently attaches the first
Telegram credential of the right type, which is usually the wrong app's bot. **After every import,
open the Telegram nodes and confirm the credential names the app you actually meant.**

That mis-binding has a second, nastier effect: **a Telegram bot can only have ONE webhook.**
Publishing a workflow bound to the wrong bot STEALS that bot's webhook. Fixing the credential later
re-points the *new* bot's webhook but leaves the *robbed* bot orphaned — its messages then vanish
silently. If a bot goes quiet after you fixed a credential elsewhere, **unpublish and re-publish its
inbox workflow** to re-register the webhook.

**Verify by routing, not by reading.** Send each bot a distinct plain message and confirm it lands
in that app's `captures/inbox/` and nowhere else. A workflow can look perfect and still be writing
into the wrong repo — GitHub answers `200 OK` either way.

**Import the fourth file too: `n8n-telegram-error-alert.json`.** It's not a workflow you trigger —
it's the target you point the other three at. After importing it, open each of Inbox/Digest/Replies
→ 3-dot menu → **Settings** → **Error Workflow** → select `[Aly & Shin Product Lab] Error Alert -> Telegram`.
Without this, a broken credential or wrong repo fails silently inside n8n forever — Telegram never
sees it (see the "verify by routing" trap above; a broken credential still shows GitHub answering the
*webhook* delivery fine, since the failure happens one step later, inside the workflow). A real
installation went three days without this before the gap was noticed — see the host app's
`docs/DECISIONS.md` if it recorded the incident.

### Running more than one app

Each app gets its own pair of tasks, its own repo, and its own `automation.lock`, so two apps can
never collide. Their dispatchers deliberately share the **same 30-minute interval** rather than being
staggered: aligned triggers mean **one wake of the PC serves every app**. Staggering would wake the
machine once per app for no benefit.

Each app's `$AUTOMATION_ENABLED` is independent — a validated app can be live while a new one stays
inert.

### Dispatcher controls — Windows, elevated PowerShell
```powershell
Get-ScheduledTask -TaskName "Aly & Shin Product Lab Command Dispatcher" |
  Select-Object State, @{n='Wake';e={$_.Settings.WakeToRun}}, @{n='Every';e={$_.Triggers[0].Repetition.Interval}}

Enable-ScheduledTask  -TaskName "Aly & Shin Product Lab Command Dispatcher"   # Telegram polling ON
Disable-ScheduledTask -TaskName "Aly & Shin Product Lab Command Dispatcher"   # OFF
```

### Change how often it wakes (elevated)
```powershell
$t = Get-ScheduledTask -TaskName "Aly & Shin Product Lab Command Dispatcher"
$t.Settings.WakeToRun = $true
$t.Triggers[0].Repetition.Interval = "PT30M"   # PT15M | PT30M | PT1H
Set-ScheduledTask -InputObject $t
```

### Sleep timing (no elevation needed)
```powershell
powercfg /change standby-timeout-ac 15    # minutes idle before sleeping on AC (0 = never)
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String "Current AC"
```

### Dispatcher controls — macOS
```bash
launchctl list | grep "com.aidevos.aly-shin-product-lab.dispatcher"
launchctl kickstart -k "gui/$(id -u)/com.aidevos.aly-shin-product-lab.dispatcher"
pmset -g | grep ' sleep'
```

## The mindset
> Old: *"How do I code this?"* → New: *"How do I keep the system flowing?"*

Inputs in (capture) → priority set (roadmap) → outputs reviewed (morning/evening). Everything between
runs itself. The three things you actually touch: **GUIDE** (how to capture), this file (how you work),
**ROADMAP** (what matters). Nothing else needs to be on your phone.

## How to "review" and revert (current reality)
Right now autonomous runs commit **straight to `main`**, which auto-deploys live — there is **no PR to
approve**. So "review" = check the morning's commits and undo anything wrong:
- Inspect: `git log --oneline -5` or open the repo on GitHub.
- Undo one bad commit (keeps history): `git revert <hash>` → push. The site redeploys clean.

If you'd rather have a **real approval gate** — runs push to a branch and open a PR you merge, so
nothing goes live until you click merge — say the word and we'll switch the runner to that. It's the
natural next step for the operator model, but it's a change to the automation, so it's parked until you
want it.
