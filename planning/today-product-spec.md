# Today — Product Specification

This specification is built on [workflow-diagnosis.md](./workflow-diagnosis.md), which is frozen and treated as the product constitution — every decision in it is authoritative here and is not revisited or re-argued. This document specifies the product that follows from it: only what the owner experiences — what they see, what they read, what they tap, and in what order. It does not name how any of it gets built.

## 1. Purpose

Today exists to remove every decision standing between the owner opening Aly & Pon and creating one piece of content. It is not a dashboard, a review queue, or a place to manage a backlog of ideas — it is a single daily starting point: one well-reasoned suggestion, handed over already made, that gets the owner to their first real action within seconds of opening the app. Its job is to make creating content today the obvious, low-effort thing to do first — not a task the owner has to plan, browse for, or decide to start.

## 2. First Five Seconds

**What appears:** one screen, immediately. Nothing precedes it — no menu, no summary of the business, no list to scan first.

**What draws attention, in order:**
- A single stated idea, sized and placed to be the first and largest thing read: *"Today's recommendation: Brownie."*
- Directly beneath it, already present with nothing to wait for: two short, plain-language lines explaining why — e.g. *"No brownie content in 6 days."* / *"Brownies are our hero product this week."*
- Below that, one button, visually heavier than anything else on the screen.
- Quieter, smaller text nearby offering a way out — "not this one," "something else" — present, legible, but clearly not the invited action.

**What the owner taps:** the one heavy button. That's the entire decision the screen asks for: not which idea, not which product, not where to look first — just whether today's stated case is good enough to act on.

## 3. Information Hierarchy

Ranked highest to lowest importance, with the reasoning for each rank:

1. **The recommendation itself** — the one thing the screen exists to say. Everything else on the screen is in service of this line; it must be read first, without effort.
2. **The reason it's being suggested** — what turns a suggestion into something worth trusting, without asking the owner to evaluate anything themselves. It earns the pick's authority in place of a track record the app doesn't have yet.
3. **The primary action** — the one thing the screen wants done next. It must read as clearly more actionable than anything else after the headline and its reason.
4. **Work already in progress or ready to publish** — visible, so nothing already started gets lost, but quieter than today's fresh recommendation. Finishing matters, but starting is the habit being built, and it should still feel like the main event.
5. **Alternative paths** ("not today," "something specific," browsing past ideas) — present but deliberately the quietest interactive elements on the screen, because they serve the exception, not the rule.
6. **Everything else about the business** (operations, history, settings) — absent from this screen entirely. Reachable elsewhere, never competing here.

## 4. Primary Action

The single primary action is **copying today's brief.**

It deserves to be the one primary action because it is the single step that turns looking at the screen into doing something with it, and it is available on every kind of day — a strong recommendation, a middling one, or none at all. Every other visible control (swap the idea, override it, browse instead) exists only to lead back to this same action with a different starting point, never to compete with it for the owner's attention. Completing it is the moment the day's content actually begins to exist.

## 5. Daily Workflow — the complete happy path

**Opening Aly & Pon** — the recommendation is already waiting. No setup, no menu, no screen to get through first.

**Today's recommendation** — the owner reads one idea and the plain reason behind it. Nothing to compare, nothing to weigh.

**Brief** — one tap hands the owner a ready-to-use creative brief, already written, already copied.

**Asset generation** — the owner takes that brief wherever they already generate images, and brings back a result. This happens away from Aly & Pon, in whatever tool the owner prefers, and stays that way for now.

**Asset selection** — the owner brings the result back to the same screen they started on and drops it in.

**Ready to publish** — the app confirms the piece is finished and holds it, ready for the owner to post wherever they post. The loop closes on the same screen it opened on; the owner is never asked to go find where their work ended up.

## 6. Alternative Flows

- **Not today** — one tap swaps to the next-best idea, with its own stated reason. No list appears unless the owner asks for one.
- **Try another take** — if a generated result isn't good enough, one tap asks for another attempt on the same idea. No need to explain what was wrong or start over.
- **Resume unfinished work** — if yesterday's thread was left open (a brief copied, no result brought back yet), that unfinished thread greets the owner before any new recommendation does. Finishing takes priority over starting something new, because two open threads is twice the decision.
- **No recommendation available** — on a day with nothing confident enough to suggest, the screen says so plainly rather than dressing up a weak guess as a strong one, and offers "something specific" instead. A reason is never invented to sound more confident than it is.
- **Multiple strong recommendations** — even when several ideas are equally good, exactly one is shown. The rest wait behind "not today" — never listed side by side, because a list is a decision, and the entire point of the screen is that there isn't one to make.
- **Existing draft** — handled the same as resuming unfinished work: a draft in progress is an open thread, and open threads come first.
- **Existing finished assets** — pieces already ready to publish stay visible in a quiet tray beneath today's action. Visible enough that nothing gets lost, quiet enough that nothing competes with today's one job.

## 7. Screen States

- **Empty** — no recommendation exists. Stated honestly, with the option to start something from scratch offered directly rather than the screen feeling broken or blank.
- **Loading** — the day's recommendation should already be ready before the owner arrives. If any part of it isn't, the reason and the action should appear a beat after the headline, rather than the whole screen waiting on a spinner.
- **Error** — if a step doesn't go through (a result fails to attach, for instance), the screen says plainly what didn't work and what to do about it, in the owner's own words, without alarm or blame.
- **Completed** — the instant a piece is ready, the screen confirms it in place, with a visibly settled, finished feel, so there's no doubt today's job is done.
- **Returning user** — identical in shape to any other day. The ritual is the product: a returning owner should see the same structure every time, only with a new idea and a new reason inside it.
- **First-time user** — the same screen, but the stated reason draws only on what's actually knowable yet. A gap-based reason ("no brownie content in 6 days") isn't shown before there's history to support it; the reasoning is always honest about the evidence behind it, never inflated to sound more confident than the data allows.

## 8. Navigation

**Should exist:**
- **Today** — the home screen; the only place a new day starts.
- **Ready to Publish** — a light view of finished, unposted pieces, most likely folded directly into Today's own tray rather than standing alone.
- **Ideas** — the full list of everything the system has noticed, for the rare moment the owner wants to browse instead of accepting today's pick.
- **Drafts** — unfinished threads, for the rare case there's more than one open at once.
- **Everything the business already needs** (production, inventory, costing, customers, and the rest) — fully available, grouped together as a secondary destination, not part of the everyday content ritual.

**Should disappear from everyday navigation:** any requirement to pass through a review queue before creating something. Ideas and Drafts become places to look if the owner wants to, never a place they have to start.

## 9. Interaction Principles

- **One primary action.** Every screen state has exactly one thing the owner is meant to do next. Secondary options exist but are never styled to compete with it.
- **Explain recommendations.** Nothing is ever suggested without a plainly stated reason. A recommendation without a reason is a demand, not a suggestion.
- **Reduce decisions, not just steps.** A fast list is still a decision. The goal is removing the choice itself wherever the system can make a good one on the owner's behalf.
- **Never expose internal workflow concepts.** The owner never needs to know how a recommendation was produced or what state something is in behind the scenes — only what it's asking of them right now.
- **Progress over perfection.** A good-enough recommendation acted on beats a perfect one the owner has to think about. The habit matters more than any single day's pick being ideal.
- **Consistency over novelty.** The screen looks and behaves the same way every day. Sameness is what makes it a ritual instead of a feature to explore.

## 10. User Language

**Words the owner should see:** "Today's recommendation," "Reason," "Copy Brief," "Not today," "Try another take," "Something specific," "Ready to publish," "Draft," "Idea" / "Ideas."

**Words that should never appear:** Opportunity (as a record or an ID), rule engine, evidence, source data, provenance, status codes, job or queue terminology, deduplication, or any phrase that describes how the system arrived at something rather than what it's telling the owner. If a word describes the machinery instead of the moment, it doesn't belong on screen.

## 11. Success Metrics

- **North Star — Content Days per Week.** The number of days per week the owner creates at least one piece of content. This is the outcome that matters: did the ritual happen today.
- **Driver — median time from opening Aly & Pon to copying the first brief.** Explains *why* the North Star is or isn't moving. If it stalls, this is the first place to look.
- **Quality — percentage of recommendations accepted without override.** Whether the owner acts on the stated pick as given, or swaps away from it. The trust check on the recommendation itself, independent of whether the owner shows up at all.

## 12. Future Expansion

Today's shape doesn't have to stay specific to content. At its center is a pattern, not a feature: one clearly stated recommendation, one plain reason, one primary action. That pattern isn't inherently about content — it could eventually carry whatever matters most in the business on a given day, whether that's a content idea, something worth reordering, or a production priority, without changing what the screen looks like or how it behaves.

Growth happens by widening what's allowed to compete for that one daily slot — never by adding more slots, more screens, or more things to choose between at once. The day Today starts asking the owner to weigh two important things side by side is the day the design has drifted from what makes it work. Everything this document specifies should still hold true even as what fills that one slot changes.
