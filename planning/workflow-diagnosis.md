# Aly & Pon — Post-PROP-027 Workflow Diagnosis (Head of Product/UX)

## Context

This is not an implementation plan. Per explicit instruction, no architecture is being proposed, PROP-028 is not being started, and no code changes are scoped here. This document is a strategic diagnosis of the owner's real-usage feedback after PROP-027, intended to align on *which problem* PROP-028 should eventually solve — before any solution is designed.

The owner's stated north star: **Aly & Pon should be the app they naturally open every morning to create and post content.** Today's workflow (Opportunities → gate check → Create Asset Job → Copy Brief → external ChatGPT → Upload → Asset appears) works mechanically but doesn't produce that daily-open habit. The task here is to explain why, using the actual current architecture as ground truth, not assumption.

## Ground truth from the codebase (not assumption)

- **Opportunity** is a system-detected recommendation object, produced by an internal deterministic rule engine (`source_type: "daily_advisor" | "marketing_advisor"`). It is **not** manually created and **not** synced from a CRM (no GHL integration exists in this repo). Users only accept/dismiss it.
- **Chain:** Opportunity → CreativeJob (**1:1**, unique index) → CreativePackage → AssetJob (**1:many, deliberately** — the schema comment explicitly calls out regenerations/retries) → Asset (1:1 per Asset Job).
- **The "one image per Opportunity" ceiling is not a database constraint.** The schema already allows many Asset Jobs (and therefore many Assets, over time) per Creative Package/Opportunity. Nothing in the data model caps it at one.
- **No UI currently exposes multiple-assets-per-opportunity or a standalone "create content" entry point.** The `createAssetJobForReadyCreativePackage` function has zero callers in the shipped UI; asset creation is only reachable by drilling into an accepted Opportunity.
- **Navigation:** Dashboard (proof/costing/kitchen-ops) is the default landing view. Opportunities sits at position 10 of 14 sidebar items; Content Studio sits at position 13 of 14. The first thing the owner sees every morning is production/ops, not content.
- **Image generation is fully external by design** (ChatGPT/manual paste), and that's an explicit non-goal to change right now — not itself the primary complaint.

This matters because it changes the diagnosis: the owner experiences "I need an Opportunity before I can create an Asset" and "one image feels restrictive" as if they were data-model limits. They are not. They are UX and product-framing decisions layered on top of a data model that already supports something looser.

## 1–3. Bottleneck breakdown, by category

**Engineering bottlenecks** (real, but not what's driving the ROI complaint):
- No standalone Asset/Post creation path decoupled from an existing Opportunity row — the only wired UI path starts from Opportunity → CreativeJob → CreativePackage. A "just let me post something" flow with no Opportunity in the picture is currently unbuildable without touching that chain.
- No in-app generation (ChatGPT round-trip is manual copy/paste/download/upload). Real friction, but explicitly out of scope by prior decision — not the thing to solve next.

**UX bottlenecks** (data model is fine; presentation is wrong):
- Content creation is 4 layers deep in a system whose home screen is built around kitchen/proof/costing ops, not content. That directly contradicts "open every morning to create content."
- There is no single "make a post" action anywhere in the app. Entry requires first locating and accepting an existing Opportunity.
- Nothing in the UI invites a second or third take on an existing Opportunity, even though the backend already allows it — so the "restrictive" feeling is a missing affordance, not a missing capability.

**Product bottlenecks** (the conceptual framing problem, which is the real issue):
- The app conflates two distinct jobs-to-be-done: (1) surface a business insight worth acting on, and (2) let the owner produce and post content. Today, job #2 is only reachable through job #1. They don't need to be coupled for daily use to feel valuable.
- Opportunity is positioned as a *gate* ("you may create content once I've detected a reason to") rather than an *accelerant* ("here's a head start, but you can always just create"). That inversion is what makes content creation feel like a secondary, derivative action instead of the app's primary action — which is exactly complaint #3 from the owner.

## 4. Challenging the current assumptions

- **Should Opportunities be user-visible?** Probably yes, in some form — the rule-engine insight is real product value and shouldn't be thrown away. But visibility ≠ mandatory gate.
- **Should they be created automatically?** They already are. That's correct and worth keeping — the mistake isn't automatic generation, it's making that generated object a *prerequisite* for content.
- **Is Opportunity the correct primary object for content creation?** No. It's a business-insight object. The primary object for a content app should be something the owner can originate at will (a Post / Draft / "today's content"), which *may* be seeded by an Opportunity but doesn't require one to exist.
- **Should multiple Assets belong to one Opportunity?** The schema already says yes. The real product question is broader: should Assets even require an Opportunity parent at all, every time? Long-term, probably not — but that's an architecture question to resolve deliberately in PROP-028, not to retrofit here.

## 5. Alternative workflows (3–5 options)

1. **"Create Post" as the primary home action.** Replace the ops-focused dashboard's top slot with a direct content-creation entry point that doesn't require selecting an Opportunity first. Opportunities appear as optional inspiration chips that can pre-fill a brief if clicked, but aren't mandatory.
2. **Opportunity Feed, one-tap convert.** Keep Opportunity-first, but collapse "accept" + "create asset job" + "copy brief" into a single tap on a feed card, and add a visible "new take" / regenerate action per card (surfacing the 1:many capability that already exists in the backend).
3. **Daily Content Digest.** On open, the app auto-selects/pre-ranks the day's top Opportunities and pre-drafts briefs for them, presented as a morning digest — no separate Opportunities list page to visit at all. Opportunity stays a backend trigger; it disappears as a navigation destination.
4. **Freeform Compose + Opportunity as optional inspiration.** A blank "New Post" flow with zero Opportunity dependency, sitting alongside (not replacing) the existing Opportunity-driven path, fully decoupling the two jobs-to-be-done.
5. **Reduce the external round-trip's friction.** Deep-link/pre-populate ChatGPT from "Copy Brief," and accept clipboard-paste images (not just file picker) on upload. A smaller, orthogonal improvement that layers on top of any of the above.

## 6. Ranking

| Option | Daily usefulness | Click reduction | Implementation effort | Long-term architecture fit |
|---|---|---|---|---|
| 1. Create Post primary action | Very high | High | Medium–high (needs a path to create content without an existing Opportunity row — an open architecture question) | High, but requires resolving the Opportunity-optional question first |
| 2. Opportunity Feed one-tap | Medium–high (capped by whether there's a fresh Opportunity that day) | High | Low (pure UI consolidation over existing backend capability) | Good; doesn't resolve the framing issue, just eases it |
| 3. Daily Content Digest | High | High | Medium (digest/ranking UI; no new data path) | High — keeps Opportunity as a clean backend trigger, no schema question raised |
| 4. Freeform Compose | High | High | Medium–high (same open architecture question as #1) | High, but same prerequisite as #1 |
| 5. Reduce round-trip friction | Medium | Medium (last-mile only) | Low | Neutral — compatible with, and complementary to, any option above |

## 7. Recommendation

Target **Option 3 (Daily Content Digest)** as the workflow to build toward next, paired with **Option 5** as a cheap complementary win. Reasoning:

- It's the most direct answer to "I want to naturally open this every morning to create content" — it makes that the first thing the app does, not something buried behind ops screens.
- It requires no change to the Opportunity data model or its automatic-generation behavior — both already work well and don't need to be touched.
- It resolves the "too restrictive" complaint for free: exposing a "new take" action on digest cards uses the AssetJob 1:many capability that already exists in the schema. No schema change needed.
- It doesn't require deciding — yet — whether content can exist without an Opportunity at all. That's a real, legitimate architecture question (raised by Options 1 and 4), but it's PROP-028's decision to make deliberately, not something to default into while chasing today's friction.

**Explicit note on the data model:** the data model is not the problem. Opportunity → CreativeJob (1:1) → CreativePackage → AssetJob (1:many) → Asset is already correct for "many assets per opportunity." Everything diagnosed above is a UX and product-positioning fix, with exactly one open architecture question worth flagging for PROP-028's scoping conversation: *should a Post/Asset ever be creatable with no Opportunity as its parent?* That question should be answered deliberately when PROP-028 is scoped — not resolved implicitly by whichever workflow ships next.

## 8. Blank-screen exercise: the ideal daily workflow (launching tomorrow)

Ignoring today's navigation entirely, if the owner opens the app tomorrow morning for the first time expecting to create content, the ideal single screen looks like this:

1. **The app opens directly into "Today," not a dashboard, not a list.** There is no ops/proof/costing screen in front of it. "Today" *is* the home screen.
2. **1–3 pre-drafted content cards sit at the top,** each seeded by the rule engine's existing Opportunity detections — but presented as ready-to-act content ideas, not as insights to review and accept. Critically, each card is **explainable, not silent**: "Today's recommendation: Brownie" with the reason stated plainly underneath ("No brownie content in 6 days." / "Brownies are our hero product this week."). At this stage the app doesn't yet have enough historical data for the owner to trust a black-box pick — showing the reason is what makes the recommendation trustworthy enough to act on without a manual decision. Each card already has its brief drafted and a one-tap "Copy Brief" action.
3. **A persistent, always-available "New Post" action sits alongside the cards**, with zero preconditions — no Opportunity required, nothing to accept first. Tapping it drops the owner into the exact same brief → copy → external-generate → upload loop, just without a pre-filled seed.
4. **Every card — seeded or freeform — has a visible "Try another take" action.** This regenerates a new Asset on the same thread. It's the same underlying capability the backend already has (AssetJob is already 1:many under a Creative Package); the ideal workflow just makes it a button instead of a hidden capability.
5. **Upload happens in place.** Paste or drop the generated image on the same card; the Asset appears immediately in a "Ready to post" strip on the same screen — no navigating elsewhere to confirm it landed.
6. **Opportunities-as-a-list, Content Studio, Products, Proof Day, etc. still exist**, reachable from a secondary nav — they're just not what the owner sees first. The rule engine keeps running exactly as it does today; it just stops being a gate and becomes a feed of pre-drafted starting points inside the one screen that matters each morning.

This preserves essentially all existing backend: the rule engine, Opportunity generation, the CreativeJob/CreativePackage/AssetJob/Asset chain, and `createAssetJobForReadyCreativePackage` are all reused as-is for the seeded cards and the "try another take" action. The **one** piece that doesn't cleanly fit the existing chain is step 3 — a "New Post" with literally no Opportunity behind it needs *something* to satisfy the Opportunity→CreativeJob relationship the chain currently assumes. That's the same open architecture question flagged in Section 7, surfacing again here because it's the one part of the ideal workflow that isn't pure UI/backend-reuse.

## 9. Ideal workflow vs. current implementation — the gap

| Ideal | Current | Gap type |
|---|---|---|
| Home screen = "Today," content-first | Home screen = Dashboard, proof/costing-first | Navigation/composition — no new backend |
| Opportunities shown as ready-to-act cards | Opportunities is a standalone list, 10th of 14 nav items, framed as accept/dismiss review | Navigation + framing — no new backend |
| One-tap "Copy Brief" per card | No brief-generation UI exists yet at all (`asset-generation-brief.ts` doesn't exist); no UI calls `createAssetJobForReadyCreativePackage` | Missing UI only — this is exactly what PROP-027B already scopes to build |
| "Try another take" per card, reusing AssetJob 1:many | No regenerate affordance anywhere in the UI, even though the backend already supports it | Missing UI affordance only — zero schema change needed |
| "New Post" with no Opportunity precondition | Every path to content creation starts from an existing accepted Opportunity | Real gap — the one item that needs an architecture decision, not just UI |
| Upload + result shown in place, same screen | Asset display (`creative-package-assets.tsx`) is read-only and lives inside the Opportunity detail screen | Composition — reuse the existing read-only display component, just relocate/embed it |

The pattern: five of six gaps are pure UI/navigation work sitting on top of backend capability that already exists or is already being built (PROP-027B). Only one gap — fully Opportunity-free content creation — touches the data model's current assumptions.

## 10. Smallest change that captures ~80% of the benefit

In priority order, none of which require new backend subsystems or schema changes:

1. **Ship the already-planned PROP-027B create-job + upload UI** (brief generation, copy-to-clipboard, file upload), but land its entry point as a prominent home-screen action rather than nested inside an Opportunity's detail view. The backend work is already scoped; this only changes *where* the resulting UI lives.
2. **Change the default landing view** from Dashboard to a lightweight "Today" view listing the top 1–3 open Opportunities with their brief-copy action front and center. This is a routing/default-view change (e.g. `product-lab.tsx`'s default `view` and `lab-state.ts` nav ordering) — composition, not new capability.
3. **Add a visible "Try another take" button** to the existing `creative-package-assets.tsx` display, wired to the existing `createAssetJobForReadyCreativePackage` function against the same Creative Package. Directly resolves the "one image feels restrictive" complaint using capability that already exists today.
4. **Reorder navigation** so content-related destinations (the new Today view, Content Studio) sit at the top of the sidebar instead of positions 10 and 13 of 14 — a config/ordering change in `lab-state.ts`, not a rebuild.

**Deliberately left out of the 80% cut:** a true zero-precondition "New Post" with no Opportunity parent at all. That's the one item that raises a real architecture question (how does a freeform post satisfy the Opportunity→CreativeJob relationship the chain assumes today) and deserves a deliberate PROP-028 scoping conversation rather than being smuggled in as a side effect of a UI pass. Everything else above ships without touching that question.

## 11. First-principles exercise: forget everything, optimize only for fewest decisions

Single stated goal: *"I need to create and post great content today with the fewest possible decisions."* Not "fewest clicks," not "fastest" — fewest **decisions**. Those aren't the same thing: a list of 3 good suggestions is fast, but it's still a decision (which of the 3?). The truly minimal design removes the choice itself wherever the system can make a good one on the owner's behalf, and only asks the human to decide where a human genuinely must.

**The ideal sequence, from a blank screen:**

1. Open the app. It lands directly on one single-purpose screen — no dashboard, no menu, no nav to read first.
2. That screen already shows one specific, ready-to-go content idea for today — brief already drafted, selected by the system, not offered as a list to pick from — **and it says why**: "Today's recommendation: Brownie. No brownie content in 6 days. Brownies are our hero product this week." At Aly & Pon's current stage there isn't yet enough historical data for the owner to trust a silent pick; a stated reason removes the need to second-guess it without adding a decision, since the owner isn't asked to weigh anything — just shown the case.
3. One tap copies the brief (and ideally hands off toward image generation directly).
4. *(Outside the app, unchanged today)* the owner generates the image externally.
5. The owner drops/pastes the result back onto the same screen.
6. The screen confirms the asset is ready, in place — no navigating elsewhere to check it landed.
7. *(Optional, only if today's idea isn't wanted)* a single "not this one" swaps to the system's next-best idea — still zero manual selection.
8. *(Optional, rare)* "something specific instead" lets the owner type their own idea when they genuinely want to override the system.
9. *(Optional)* "try another take" regenerates a new asset on the same idea if the first result isn't good enough to post.

Everything marked optional is reachable but never required — the default path from open to done involves exactly one unavoidable human decision (did I like what came back well enough to post it), plus one external round-trip that isn't the app's decision to remove today.

## 12. Backend-readiness classification, step by step

| Step | Classification | Why |
|---|---|---|
| 1. Land on single "Create" screen by default | Pure UI/composition | Routing/default-view change only |
| 2a. System auto-selects today's best idea | Already supported by the backend | The rule engine already produces ranked, timestamped Opportunity rows; picking the top one is a query, not new capability |
| 2b. Brief is already drafted as text | Small backend addition | No brief-generation function exists yet (`asset-generation-brief.ts` doesn't exist) — but this is exactly what PROP-027B already scoped to build, not a new decision |
| 2c. Recommendation shows its reason, not just its pick | **Already supported by the backend** | Opportunity rows already carry `reason`, `summary`, and `evidence` fields — this is stored data today, just never rendered. Showing it is a copy/UI decision, not a new capability, and it's what makes the pick trustworthy before the rule engine has a long track record |
| 3. One-tap copy brief | Pure UI/composition | Clipboard-copy pattern is already precedented in `ai-advisor-panel.tsx` |
| 5. Upload/paste image back in | Small backend addition | Upload wiring doesn't exist yet; a browser-portable hashing blocker is already identified in the team's own PROP-027A scope — known work, not new architecture |
| 6. Asset created + shown ready, in place | Already supported by the backend | `createAssetJobForReadyCreativePackage` and the Asset table already exist; only needs to be called and displayed inline |
| 7. "Not this one" swap to next idea | Already supported by the backend | Just selects a different existing Opportunity row — no new capability |
| 8. "Something specific instead" (freeform, no system idea at all) | **Requires a fundamental architecture change** | Breaks the assumption the whole chain is built on: every CreativeJob currently requires an existing Opportunity row (1:1, enforced by a unique index) |
| 9. "Try another take" regenerate | Already supported by the backend | AssetJob is deliberately 1:many under a Creative Package — this is exactly what that design already allows |

**Reading the table:** six of nine steps need zero new backend work at all; two more are small, already-anticipated additions (not new decisions — PROP-027A/B already named them); exactly one step — and only the rare, opt-in one — requires touching the data model's core assumption.

## 13. Minimum change to reach ~90% of the ideal

Ship steps 1, 2a, 2c, 3, 6, 7, and 9 as pure UI/composition work reusing what already exists, plus the two small, already-scoped backend additions (2b brief drafting, 5 upload wiring — both already named in PROP-027A/B). That covers the entire default daily path: open → one idea already waiting, with its reason stated → copy brief → generate externally → paste back → done, plus "not this one" and "try another take" for when the default isn't right. The reason display (2c) costs nothing extra to ship alongside 2a — it's the same query, rendering fields that already exist on the Opportunity row.

Deliberately excluded from this cut: step 8, freeform content with no system idea behind it at all. It's the one architecture-changing item, and it's also the rare path — most mornings, a good auto-selected idea beats a blank page. Leaving it out costs little of the daily experience and keeps this a 90%-of-ideal change with zero schema changes, consistent with "preserve as much of the existing backend as possible."

## 14. Resolving the philosophy question: "Today" vs. "Create Content"

These are genuinely different philosophies, and per the instruction not to average conflicting patterns, here is a direct pick rather than a blend of both screens:

**Pick: Option B's shape — one single primary action, not a hub of choices — but reject Option B's literal first sub-step.**

Reasoning: "fewest possible decisions" and "open naturally for three years" both argue against Option A's hub. A menu of "Suggested posts / New Post / Continue drafts / Opportunities" asks the owner to make a choice every single morning before they've done anything — even a trivial choice, repeated across a thousand mornings, is decision fatigue by another name, and it's exactly the kind of low-grade friction that erodes a habit long before any single morning feels like a big deal. A single, always-identical action is what makes a ritual — the same reason a camera app opens straight to the camera instead of a menu of "take photo / view gallery / edit."

But Option B as drawn — "Create Content → choose product → everything else automatic" — reintroduces the very decision it should be removing. Manually picking a product is a real decision, and the rule engine already exists specifically to make that call well. Discarding that intelligence in favor of a manual first step is worse for the stated goal than Option A's menu, not better.

**Net position:** one primary action, always in the same place, that leads directly into a system-selected idea with its brief already drafted — Option B's single-entry-point structure, fed by Option A's suggestion intelligence instead of a manual "choose product" step. "Continue drafts" and "Opportunities-as-a-list" still exist, but as secondary/overflow surfaces, never as something the owner has to look at or choose between before creating.

One refinement on top of this: the system-selected idea should be **explainable, not silent**. At Aly & Pon's current stage there isn't yet enough historical data for the owner to trust a black-box pick, so the pick needs to show its reasoning — "Today's recommendation: Brownie. No brownie content in 6 days. Brownies are our hero product this week." — using the `reason`/`summary`/`evidence` fields the Opportunity row already stores. This still removes the decision (the owner isn't asked to choose), but it earns the trust that a bare, unexplained suggestion wouldn't.

## 15. Three metrics, three jobs — not one number

A single north star can't carry this: it would tell you *whether* the habit is forming but nothing about *why* it isn't, and nothing about whether the recommendation itself deserves the owner's trust. Three metrics, each doing one job, none of them a technical metric:

**North Star — Content Days per Week.** The number of distinct calendar days per week on which the owner creates at least one Asset in the app. This is the outcome that actually matters: did the ritual happen today, not just could it. Measurable today from data that already exists (`assets.created_at` / `asset_jobs.completed_at`) — no new tracking required.

**Driver — median time from opening Aly & Pon to copying the first brief.** This is the metric that explains *why* Content Days is or isn't climbing. It's a friction gauge: a workflow can be fast and still never get opened, so it isn't the north star, but if Content Days stalls, this is the first place to look — is the app taking too long to get the owner to their first real action.

**Quality — percentage of recommendations accepted without override.** How often the owner acts on the system's stated pick as-is, versus swapping to "not this one" or typing something specific instead. This is the trust check on the recommendation engine itself: it's the metric that tells you whether *explaining* the pick (§14) is actually working, separately from whether the owner shows up at all. A high Content-Days number sitting on top of a low override-free rate would mean the owner is showing up but fighting the recommendation every time — a real problem the north star alone would hide.

Together: North Star tells you if the habit exists. Driver tells you where friction lives if it doesn't. Quality tells you if the thing being recommended is actually earning trust. Rejected as candidates for the top slot, but folded in above rather than discarded: *first app opened each morning* — the truest expression of the goal, but unobservable without new, invasive instrumentation outside the app.

## 16. The first five seconds

Ignoring architecture and implementation entirely — this is only what the owner sees, from launch to first action.

**0:00 — Launch.** No splash screen, no loading dashboard, no menu flashes past on the way to somewhere else. The screen that appears *is* the final screen. Quiet background, single column, nothing else competing for attention.

**0:00–0:01 — The pick.** The first and largest thing the eye lands on, styled like a headline, not a list item: *"Today's recommendation: Brownie."* One idea. Not three to choose from.

**0:01–0:03 — The reason.** Directly beneath it, already there — no spinner, no "loading insights" — two short, plain-language lines: *"No brownie content in 6 days."* / *"Brownies are our hero product this week."* Nothing technical, nothing the owner has to interpret. It reads in under two seconds because there's nothing to decide yet, only something to notice.

**0:03–0:05 — The one action.** Below that, exactly one button, visually heavier than anything else on the screen: *"Copy Brief."* Smaller, quieter text nearby offers "Not this one" and "Something specific instead" — present, legible, but clearly not what the screen wants the owner to do. There is one obvious next move.

**0:05 — First action.** The owner taps "Copy Brief." That's the whole decision: not *which* idea, not *which product*, not *where to click first* — just whether today's stated case is good enough to act on. Everything else in this document — the digest, the explainable pick, the nav reorder, the three metrics — exists to make this exact five seconds happen reliably, every morning, for three years.

## 17. Long-term vision (not PROP-028)

This document intentionally optimizes for one thing: making Aly & Pon the owner's daily content-creation tool. That scope is deliberate, not a limitation to apologize for.

If it succeeds, that content workflow doesn't have to stay the whole app — it can become one section of a broader "Today" operating system that also surfaces production, inventory, customer, and business priorities alongside content. That broader operating-system vision is real and worth naming, but it is deliberately **outside the scope of this diagnosis**. Nothing above should be read as an argument against it; it's an argument for sequencing it after content-creation habit is proven, not instead of it.

---

*Companion document: [today-product-spec.md](./today-product-spec.md) — the Today Product Specification, built on this diagnosis as its authoritative foundation.*
