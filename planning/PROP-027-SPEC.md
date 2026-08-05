# PROP-027 — Engineering Specification

> **External Creative Workspace as the first real Asset Job executor.**
> Status: specification. No code, no diffs. Architecture approved by the CTO review (2026-08-05);
> this document converts those decisions into buildable requirements.
>
> Approved decisions treated as requirements: external-workspace abstraction (never vendor-coupled),
> human-as-executor on the existing Asset Job pipeline, browser/mobile upload as the primary path,
> no Telegram, no n8n, provider neutrality with provenance as the only difference, and advisory
> dimensions without weakening byte/MIME/SHA-256/deterministic-storage validation.

---

## 0. Blocking findings — problems the approved architecture creates that the CTO review did not identify

Six issues, all verified against the code. Each is flagged with impact and the **smallest**
correction. None requires an architectural change; four are mechanical, one narrows a CTO-review
recommendation to fit an existing guard, and one (P3) turns out to need no code change at all once
the vocabulary is corrected — see below.

### P1 — `node:crypto` makes the validation chain browser-incompatible (BLOCKER)

[asset-binary.ts:1](../src/lib/asset-binary.ts#L1) imports `createHash` from `node:crypto`. It is the
**only** Node-only import anywhere in `src/lib/`, and it is used by exactly one function, `sha256Hex`.

**Impact:** the approved primary path is browser upload, and the entire chain
`inspectAssetBytes → validateAssetCandidateBytes → materializeAssetJobFiles` transitively depends on
this import. As written, **none of it can run in a browser.** PROP-027B is impossible without fixing
this. The dynamic `await import("./asset-binary.ts")` at
[asset-jobs.ts:701](../src/lib/asset-jobs.ts#L701) defers the failure to runtime rather than build
time, so this would have surfaced as a broken page, not a compile error.

**Smallest correction:** new `src/lib/asset-digest.ts` exporting
`sha256Hex(bytes: Uint8Array): Promise<string>` implemented on Web Crypto
(`globalThis.crypto.subtle.digest("SHA-256", …)`), which is present in both Node 18+ and every target
browser. Remove the `node:crypto` import. `inspectAssetBytes` and `validateAssetCandidateBytes`
become `async`. **All four call sites are already inside async functions**, so the ripple is
signature-only. Hashing algorithm, hex encoding, and every validation rule stay byte-for-byte
identical — this is a runtime-portability change, not a security change.

### P2 — the result envelope hardcodes `worker: "mock"` (BLOCKER)

[asset-file-materialization.ts:171](../src/lib/asset-file-materialization.ts#L171) builds every
envelope with `worker: "mock"`, ignoring `job.workerType`.

**Impact:** every externally-produced asset would be permanently recorded as mock-generated, in the
`asset_jobs.result` envelope *and* — via `buildAssetContentFromCompletedJob` — in the immutable
`assets.content` freeze point. Silent provenance corruption with no error.

**Smallest correction:** `buildResultEnvelope` takes the worker type from `job.workerType`.
`"external"` is added to `ASSET_JOB_WORKER_TYPES`, which `validateAssetJobResultEnvelope` already
validates against — a pure TypeScript union addition, no migration.

### P3 — retired: `provider`/`model` are not this milestone's provenance surface (RESOLVED — NO CODE CHANGE)

The columns exist and are nullable, but no code path populates them today. An earlier draft of this
spec proposed a new `set_asset_job_attempt_provenance` RPC to fix that. **On reconsideration, that
targeted the wrong field.** `provider`/`model` were reserved, by the PROP-023 migration's own
comment, specifically for *"the first real **provider** milestone"* — meaning API-vendor
identification (mirroring the Creative Job precedent: `provider: "anthropic"`, `model:
"claude-..."`). Writing `provider = "external"` would repeat, one level up, the exact category
error P4/decision-6 warns against for `model`: a value meaning *"no API vendor was used"* stored in
a column whose contract is *"which API vendor was used."* It also adds nothing `worker_type`
doesn't already say — one job produces at most one attempt today (no requeue mechanism exists
anywhere; a job either stays `queued` or moves to a terminal state and a retry is always a *new*
job), so `provider` would be a pure, confusing echo of `asset_jobs.worker_type`.

**Corrected decision:** `provider`/`model` are **not touched by PROP-027 at all** — they stay `null`
for `external` jobs, exactly as for `mock`, with zero information lost: `worker_type` (already on
the job) fully answers "was this API-executed," and `sourceWorkspace`/`sourceKind` (P4, below)
answer "which tool or origin," in more useful detail than a single `provider` string ever could.
This also means **no SQL migration is needed for provenance at all** —
`claim_asset_job_with_attempt` and `finish_asset_job_attempt` are both untouched, and the
provenance-atomicity question that motivated the original RPC never arises, because there is
nothing to write on that table. `provider`/`model` remain honestly reserved for whenever a genuine
API executor is added later — see Non-goals.

### P4 — `prompt` is a guarded disallowed column; CTO recommendation #2 must be narrowed (CONFLICT)

The CTO review recommended "capture the actual prompt at import." But
[supabase-add-asset-job-attempts.sql:99](../supabase-add-asset-job-attempts.sql#L99) lists `prompt` in
the disallowed-column guard, and the migration header states the intent plainly: never store
"stack traces, prompts, raw provider requests/responses, or credentials." Adding a `prompt` column
would make the guarded migration raise on re-run.

**Impact:** the recommendation as written is unbuildable and would violate a deliberate hygiene
boundary.

**Smallest correction — narrow it, don't fight it:** store a **brief fingerprint and version, plus
the actual provenance a human source needs**, never prompt text: `sourceWorkspace` (the declared
tool/channel — `"chatgpt"`, `"midjourney"`, `"camera"`, generic `"freelancer"`, never a person's
name), `sourceKind` (a closed `"ai_generated" | "photograph" | "human_designed"` union),
`briefSchemaVersion` (the `AssetGenerationSpecV1.schemaVersion`, currently always `"v1"` —
future-proofing, not where the real signal lives), and `briefSha256` (a hash of the canonical
exported brief — this is what actually does the drift-detection work: "was this asset made from the
brief we think it was?"). All four are additive optional fields on
`AssetJobResultEnvelope.metadata` → `assets.content.metadata`, written once, atomically, inside the
already-existing `complete_asset_job_with_files` call — no new RPC, no new migration. This satisfies
§5's "prompt version" requirement while respecting the guard. **Explicitly prohibited:** smuggling
raw prompt text into a `jsonb` field to evade a column-name guard, and smuggling a person's name
into `sourceWorkspace` (see Non-goals — per-person attribution is a separate, app-wide,
not-yet-made decision).

### P5 — two different checks share the reason string `dimension-mismatch` (HIGH RISK OF MIS-FIX)

- [asset-generation-validation.ts:73-74](../src/lib/asset-generation-validation.ts#L73-L74) — compares
  candidate against **spec** (1080×1080). **This is the one the approved decision makes advisory.**
- [asset-binary.ts:164-165](../src/lib/asset-binary.ts#L164-L165) — compares **declared** metadata
  against **decoded bytes**. **This must stay a hard rejection** — it is the anti-tamper check.

Both return `reason: "dimension-mismatch"`.

**Impact:** an implementer grepping the reason string will loosen the wrong check, or both, silently
destroying the byte-integrity guarantee the approved decision explicitly protects.

**Smallest correction:** rename the spec-level reason to `spec-dimension-advisory` and the byte-level
reason to `declared-dimension-mismatch` before touching either. A test must assert the byte-level
check still rejects.

### P6 — no UI path creates an Asset Job (SCOPE)

`createAssetJobForReadyCreativePackage` exists in lib but has no caller in `src/`.
[creative-package-assets.tsx](../src/components/creative-package-assets.tsx) is strictly read-only.
Mobile-only operation therefore requires PROP-027B to add **both** job creation and upload — creating
the job is not already solved.

---

## Non-goals

PROP-027 explicitly does not attempt to solve the following. Naming them here is so an absence reads
as a decision, not an oversight, during implementation and review.

- **Populating `asset_job_attempts.provider`/`model`.** They stay `null` for `external` jobs, exactly
  as for `mock` — reserved exclusively for a genuine future API executor (see retired P3). PROP-027
  is "the first real, non-mock asset milestone," not "the first API-provider milestone" — those are
  different claims, and only the second ever populates these columns.
- **OS-level share-sheet registration.** Appearing as a destination when sharing FROM another app
  requires a Web App Manifest, `share_target`, and home-screen install — a materially larger,
  platform-inconsistent (notably absent on iOS Safari) PWA feature. What ships is picker/camera-roll/
  camera access via a plain file input, not share-target registration (see §7).
- **Per-person attribution.** `sourceWorkspace` records a tool/channel category (e.g. generic
  `"freelancer"`), never a name. Who specifically produced an asset is unanswerable today because
  this app has no per-user identity model anywhere — RLS is `using(true)` for every authenticated
  credential holder. That is an app-wide decision (`MARKETING_MODULE.md` Open Decision 10), not
  something this milestone solves.
- **A server-side execution boundary.** Claim, upload, and completion continue to run browser-side on
  the authenticated session, matching every other write this app already makes. Standing up
  `app/api/` or a trusted runner is explicitly deferred.
- **Approve/reject or any human review gate.** Every Asset this milestone materializes is
  `generated`, not `approved` — the review gate is PROP-028's job entirely.
- **Bulk upload, multi-file assets, or non-image kinds.** One file, one job, `asset_kind = "image"`
  only — carousel/reel/video/story are each their own future, separately-scoped milestone.
- **Resumable upload, offline queueing, or background sync.** A failed upload can be retried without
  re-picking the file; it cannot resume a partial transfer or queue while offline.
- **Reopening or requeueing a terminal Asset Job.** No mechanism exists, or is added, to move a
  `failed` job back to `queued`. Retry always means a new Asset Job.
- **Cross-job or global content-addressed deduplication.** Reuse is scoped strictly to the same
  `{jobId, attemptNumber}`; identical bytes uploaded to a different job always produce a new,
  independent Storage object.
- **Verifying that the declared workspace is truthful.** `sourceWorkspace`/`sourceKind` are
  self-reported by the operator at upload time; PROP-027 does not detect or police mislabeling.
- **Choosing or committing to a real API vendor.** PROP-027 proves the executor seam is real; it does
  not evaluate, select, or integrate OpenAI, Imagen, or any other API (CTO review, "what should
  wait").
- **Raw prompt storage or prompt history.** Only a content hash of the rendered brief
  (`briefSha256`) is kept, for drift detection — never the prompt text itself.

---

## 1. User stories

**Owner, on a phone, mid-morning:**

- **US-1** — As the owner viewing a ready Creative Package, I can tap **Create asset job** so that a
  new Asset Job exists in `queued` state for that package.
- **US-2** — As the owner, I can see the **generation brief** for a queued Asset Job, rendered as
  readable text, so I know exactly what to ask an external workspace for.
- **US-3** — As the owner, I can **copy the brief to my clipboard** in one tap so I can paste it into
  ChatGPT, Claude, Midjourney, or Canva without retyping.
- **US-4** — As the owner, I can declare **which workspace produced this image** (a free-text or
  select field — ChatGPT, Midjourney, Canva, camera, …) and **whether it's AI-generated, a
  photograph, or human-designed**, so the asset's provenance is truthful, without the system caring
  which specific workspace I picked.
- **US-5** — As the owner, I can **upload an image** for a queued Asset Job from my camera roll, my
  camera, or the Files/Photos picker, and see it validated and stored.
- **US-6** — As the owner, I can **photograph real product** and upload it through the identical path,
  because a real photo is a first-class asset, not a fallback.
- **US-7** — As the owner, if my image is not exactly 1080×1080, I see a **non-blocking warning** that
  states the actual dimensions, and the upload still succeeds.
- **US-8** — As the owner, if my upload fails (bad file, network drop), I see a **specific reason**
  and can **retry without re-picking the file**.
- **US-9** — As the owner, I see the completed Asset in the same Opportunities view, with a preview,
  its provenance, and its actual dimensions.
- **US-10** — As the owner, if I upload the same image twice for the same job, the system **reuses**
  the existing object rather than duplicating it, and tells me so.

**Operator, at a desktop:**

- **US-11** — As an operator, I can run a CLI `export` to produce the brief for a queued Asset Job,
  without claiming or mutating the job.
- **US-12** — As an operator, I can run a CLI `import --job-id <id> --file <path> --workspace <name>`
  to push a local image through the identical validation and materialization path.
- **US-13** — As an operator, if my import file is invalid, the job is **not claimed** and remains
  `queued` — failure costs nothing.

**Explicitly out of scope:** approve/reject (PROP-028), publishing, multi-file kinds, bulk upload,
editing a brief, regenerating in place.

---

## 2. Workflow — every state transition

```
Creative Package (status: ready)
        │
        │  US-1  create Asset Job (worker_type = "external")
        ▼
   ┌─────────┐
   │ queued  │◄──────────────────────────────┐
   └────┬────┘                               │
        │  US-2/3  read brief (READ-ONLY —   │ validation fails
        │          job is NOT claimed)       │ BEFORE claim:
        │                                    │ job untouched
        │  US-5/12  bytes supplied ──────────┘
        ▼
   [pre-claim local validation: MIME, size, decode, declared-vs-actual]
        │  passes
        ▼
   claim_asset_job_with_attempt  →  attempt #N created
        │
        ▼
   ┌─────────┐
   │ running │
   └────┬────┘
        │  executor returns the already-validated candidate (zero I/O)
        │  spec-dimension check → ADVISORY (warn, continue)
        │  byte validation → HARD (mime / sha256 / size / declared-vs-actual)
        │  Storage upload (deterministic path, upsert: false)
        │  complete_asset_job_with_files RPC
        │    (envelope.metadata carries sourceWorkspace/sourceKind/briefSha256 —
        │     asset_job_attempts.provider/model are NOT written; see retired P3)
        ▼
   ┌───────────┐        ┌────────┐
   │ completed │        │ failed │
   └───────────┘        └────────┘
        │                    │
        ▼                    ▼
   Asset + Asset Files   last_error set, attempt finished
   visible in /opportunities
                             │  US-8 retry → new Asset Job (never reopen a terminal job)
                             └──────────────────────────────────────►
```

**The load-bearing rule, inherited from `manual-text-provider.ts`:** *validate before claiming.* A
malformed file must fail locally and leave the job `queued`. Only bytes that have already passed
local inspection may cause a claim.

**Terminal jobs are never reopened.** A failed job stays failed; retry means a new Asset Job against
the same Creative Package. `asset_jobs.creative_package_id` is deliberately non-unique for exactly
this reason.

---

## 3. Asset Job lifecycle, with failure paths

| # | Stage | DB state | Failure mode | Result |
|---|---|---|---|---|
| 1 | **Queued** | `status=queued` | Creative Package not `ready` | Job never created; UI explains why |
| 2 | **Brief Ready** | unchanged — read-only | Package content not v1 | Brief unavailable; job stays `queued`, untouched |
| 3 | **Waiting for External Creation** | unchanged | *(none — outside the system)* | Job may sit indefinitely; this is normal |
| 4 | **Upload** | unchanged until validation passes | wrong MIME, >10 MB, undecodable, GIF | **Rejected pre-claim.** Job stays `queued`. No attempt row. |
| 5 | **Claim** | `queued → running`, attempt #N | job already `running`/terminal | RPC returns no row → "not in claimable state" |
| 6 | **Validation** | `running` | declared ≠ decoded (P5 hard check) | `running → failed`, attempt `failed` |
| 6b | *spec dimension ≠ 1080×1080* | `running` | **not a failure** | Warning recorded; flow continues |
| 7 | **Materialization** | `running` | upload failed | `failed`; current-run uploads cleaned up |
| 7b | | | object exists, bytes match | **Reused.** `outcome: "existing"` |
| 7c | | | object exists, bytes differ | `existing-object-verification-failed`; pre-existing object never deleted |
| 7d | | | RPC failed | `failed`; current-run uploads cleaned up |
| 7e | | | RPC rows inconsistent | `idempotency-conflict`; cleanup runs |
| 8 | **Completed** | `completed` + Asset + Files | attempt finish fails | Job stays correctly `completed`; attempt cosmetically stale (accepted, pre-existing) |

**Job-first / attempt-second ordering is preserved unchanged.** A crash between the two writes leaves
the job terminal and only the attempt stale — never the reverse.

---

## 4. File responsibilities

### New files

| File | Purpose | Responsibility | Reason |
|---|---|---|---|
| `src/lib/asset-digest.ts` | Portable SHA-256 | `sha256Hex(bytes): Promise<string>` on Web Crypto | **P1.** Removes the only Node-only import so the chain runs in a browser. Isolated so there is exactly one hash implementation. |
| `src/lib/external-asset-provider.ts` | The external-workspace executor | Build a candidate from supplied bytes; return it via `AssetJobExecutor`. **Zero I/O, no `fetch`, no SDK.** | Mirrors `manual-text-provider.ts` exactly one layer down. This is the whole "human as provider" decision, in one file. |
| `src/lib/asset-generation-brief.ts` | Render the brief | Pure `AssetGenerationSpecV1 → string`, plus `briefSha256` | Shared by CLI export and the browser UI so both emit byte-identical briefs. Fingerprint satisfies **P4**. |
| `src/lib/asset-upload-intake.ts` | Browser-side pre-claim intake | `File → Uint8Array`, MIME/size guard, decode, build candidate, return warnings | Enforces validate-before-claim in the browser. Kept out of the component so it is unit-testable without JSX. |
| `src/components/creative-package-asset-create.tsx` | Job creation + brief + upload UI | Create job, show/copy brief, workspace field + AI/photograph/human-designed selector, file input, warnings, retry | **P6.** No UI path creates a job today. Separate component so the read-only viewer stays read-only. |
| `scripts/asset-workers/run.ts` | Desktop CLI | `export` / `import` subcommands | Mirrors `scripts/creative-workers/run.ts`. Desktop and bulk path. |

### Modified files

| File | Change | Reason |
|---|---|---|
| `src/lib/asset-binary.ts` | Drop `node:crypto`; import from `asset-digest`; `inspectAssetBytes`/`validateAssetCandidateBytes` become `async`; rename byte-level reason to `declared-dimension-mismatch` | **P1**, **P5**. Validation rules unchanged. |
| `src/lib/asset-generation-validation.ts` | Spec-dimension check returns a **warning**, not a rejection; rename to `spec-dimension-advisory`; validation result gains `warnings: string[]` | Approved dimension policy. Every other check (count, position, MIME, duration, size) stays hard. |
| `src/lib/asset-file-materialization.ts` | `buildResultEnvelope` takes worker type from the job; `materializeAssetJobFiles`'s `args` gains an optional `metadata?: { sourceWorkspace?, sourceKind?, briefSchemaVersion?, briefSha256? }`, folded into the envelope's `metadata` | **P2**, P4. One function, one call site, all four fields — no new RPC. |
| `src/lib/asset-jobs.ts` | Add `"external"` to `ASSET_JOB_WORKER_TYPES`; `await` the now-async byte validation; `AssetJobRunnerOptions` gains optional `sourceWorkspace`/`sourceKind`, threaded into the materialization call; thread warnings | Union addition, no migration. No provenance RPC — see retired P3. |
| `src/components/creative-package-assets.tsx` | Render actual dimensions, `sourceWorkspace`/`sourceKind`, and any advisory warning | Owner must see what was actually stored (US-9). |

**`src/lib/asset-job-attempts.ts` is untouched.** No provenance write path is added to it — see
retired P3.

**Untouched, deliberately:** every Creative Job file, `assets.ts`'s freeze point, `asset-files.ts`,
**all shipped SQL** (this milestone introduces no new `.sql` file at all), and the entire
inventory/costing/baking domain.

---

## 5. Database changes

**No migration. No table changes. No new columns. No new RPC.** This is a direct consequence of
retiring P3 and correcting the provenance vocabulary (P4): every meaningful piece of provenance data
already has a home in existing, additive, TypeScript-level surfaces.

| Aspect | Decision | Why |
|---|---|---|
| New tables | **None** | The approved architecture forbids a second asset model. |
| New columns | **None** | Nothing needs a new column — see below. |
| `asset_job_attempts.provider`/`.model` | **Untouched — remain `null` for `external`, exactly as for `mock`** | Retired P3: reserved exclusively for a real future API executor; writing `"external"` here would be the same category error P4 rejects for `model`, one column up. |
| `sourceWorkspace` | Lives in `AssetJobResultEnvelope.metadata` → `assets.content.metadata`, a free string, open vocabulary, no enum | Mirrors `content_journal.entry_type`'s and `content_drafts.content_type`'s existing open-vocabulary precedent. Never a person's name (see Non-goals). |
| `sourceKind` | Same location, closed TS union `"ai_generated" \| "photograph" \| "human_designed"` | Small and closed because this distinction has real downstream meaning (fake product photography is a fabricated number). |
| `briefSchemaVersion` / `briefSha256` | Same location | `briefSha256` does the real drift-detection work; `briefSchemaVersion` is future-proofing (currently always `"v1"`). |
| Prompt storage | **Never, anywhere.** | **P4** — `prompt` remains a guarded disallowed column, untouched. |
| Threading path | `AssetJobRunnerOptions` gains optional `sourceWorkspace?`/`sourceKind?`; `materializeAssetJobFiles`'s `args` gains optional `metadata?`; both flow into `buildResultEnvelope` | The operator declares these in the UI at upload time (US-4) — they must be threaded from there down to the one already-atomic completion call, not invented at the DB layer. |
| Atomicity | Free — these fields ride inside the `p_result` argument `complete_asset_job_with_files` already accepts and writes atomically | No new transaction, no new race to reason about. |

**`AssetContentV1` extension** — additive optional fields only:
`sourceWorkspace?`, `sourceKind?`, `briefSchemaVersion?`, `briefSha256?`, `actualWidth?`,
`actualHeight?`. Existing rows without them stay valid; nothing backfills or infers. Matches the
app-wide nullable-additive convention. Verified safe against `validateAssetJobResultEnvelope`
(`asset-jobs.ts:264-293`), which checks required fields but never rejects unknown ones.

---

## 6. Validation

**Hard rejections — never weakened (approved decision 7):**

| Check | Where | Behavior |
|---|---|---|
| MIME allowlist (PNG/JPEG/WebP) | intake + candidate validation | Reject |
| Byte decode | `inspectAssetBytes` | Reject (GIF gets its own message) |
| Declared vs. decoded MIME | `validateAssetCandidateBytes` | Reject |
| **Declared vs. decoded dimensions** | `validateAssetCandidateBytes` | **Reject** — P5's hard half |
| Declared vs. actual byte size | `validateAssetCandidateBytes` | Reject |
| SHA-256 computation and storage-path determinism | `asset-digest` + `buildGeneratedAssetObjectPath` | Unchanged |
| Empty / >10 MB | intake + candidate validation | Reject |
| File count = 1, position = 0, no `durationMs` | candidate validation | Reject |

**Advisory (the only relaxation):** candidate dimensions vs. `spec.dimensions` (1080×1080). Records
actual dimensions, emits a warning, continues. Applies to **all** providers, so a future API executor
inherits it — this is what unblocks OpenAI's 1024×1024.

**Duplicate detection — scoped precisely, so no reader assumes more than exists:**
- **Within the same `{jobId, attemptNumber}`** (a retried upload for a still-running attempt — e.g.
  the browser's own fetch timed out and retried): the storage path
  `asset-jobs/{jobId}/attempt-{n}/{sha256}.{ext}` collides by construction. The existing object is
  downloaded, re-inspected, and compared on sha256 + size + MIME + dimensions; matching → reuse,
  differing → fail without ever deleting the pre-existing object. **This is the only case "reuse"
  means anywhere in this spec.**
- **Concurrent double-tap before claim:** the atomic `claim_asset_job_with_attempt` UPDATE guarantees
  at most one caller ever claims a given `queued` job (verified: single `UPDATE ... WHERE
  status='queued' RETURNING *`, serialized by Postgres row locking). The second caller's claim
  returns zero rows; the existing client wrapper (`claimQueuedAssetJobWithAttempt`,
  `asset-jobs.ts:527-550`) already re-reads and returns `reason: "not-queued"` with a legible
  message — this is existing, correct behavior, not new work.
- **Retry after a failed terminal job:** no requeue/reopen mechanism exists anywhere in this
  codebase. Retry is structurally a **new** Asset Job with a **new** `id`, which produces a
  **structurally different** Storage path even for byte-identical content. There is nothing to
  detect or reuse across this boundary.
- **Identical bytes submitted to a different, unrelated job:** **never deduplicated, by design.**
  Two different Assets must never share one Storage object — deleting one Asset File must never be
  able to affect a different Asset. No global content-addressed dedup exists or is proposed.

**Upload failures:** current-run uploads are cleaned up; pre-existing objects never are. Distinct
reasons (`storage-upload-failed`, `db-materialization-failed`, `cleanup-failed`,
`idempotency-conflict`) must reach the UI as distinct messages, not one generic error.

**The UI must disable the upload control synchronously on first interaction**, before any network
call — the primary defense against a double-tap ever reaching a second round-trip. The atomic claim
above is the backstop, not the primary defense.

---

## 7. Browser upload

**One `<input type="file" accept="image/png,image/jpeg,image/webp">`** delivers every required
surface — this is the whole reason the browser path beat Telegram and Drive:

| Surface | How it works | Extra code |
|---|---|---|
| Desktop file picker | Native dialog | None |
| Desktop drag-and-drop | `onDragOver`/`onDrop` on the label, `dataTransfer.files` | ~15 lines |
| Mobile camera roll | OS picker on tap | None |
| Mobile camera | Same picker's "Take Photo" | None |
| Mobile Files/Photos picker | Same input surfaces Drive/Files-backed providers the OS picker offers | None |

**Not included, and not free:** true OS-level share-sheet registration — the app appearing as a
destination when the operator taps Share from *another* app (Photos, a chat app) — requires a Web
App Manifest declaring `share_target`, generally a home-screen install, and has materially
inconsistent platform support (notably absent on iOS Safari). That is a real, separate PWA feature,
not a side effect of `<input type="file">`, and is explicitly out of scope (see Non-goals). What
ships is picker/camera-roll/camera access, which is what US-5/US-6 actually need.

**Mobile ergonomics (US-5, US-8):**

- Tap targets ≥ 44 px; the file input is a full-width labeled control, never a bare `<input>`.
- **The picked `File` is held in component state.** A failed upload retries the same file — no
  re-picking. This is the single most valuable mobile affordance given unreliable connectivity.
- Explicit `isUploading` state disabling the control **synchronously, before any network call** — a
  double-tap on a slow connection must not create two attempts. This is the primary defense; the
  atomic DB-level claim (§6) is the backstop, not the other way around.
- Local decode happens **before** any network call, so a wrong file fails instantly and offline.
- Warnings (advisory dimensions) render in a distinct, non-alarming tone — the upload succeeded.
- Deliberately **not** built: resumable upload, offline queue, background sync, image resizing,
  client-side cropping, multi-select.

**Unmount safety:** the existing `createAssetUiRequestCoordinator` already solves stale-request and
unmount races for this surface and must be reused, not reimplemented.

---

## 8. Future compatibility — how an API executor drops in

Adding OpenAI, Imagen, or any future API changes **exactly three things**:

1. Add `"openai_image"` to `ASSET_JOB_WORKER_TYPES` (TypeScript union — no migration).
2. Add one executor file that calls the API and returns `GeneratedAssetFileCandidate[]`.
3. Give `provider`/`model` their **first-ever real values** — this is the milestone the original
   migration comment meant. Since PROP-027 adds no provenance RPC (retired P3), that future
   milestone owns designing its own small, atomic write path (most likely: derive `provider` from
   `worker_type` directly inside `claim_asset_job_with_attempt`'s existing INSERT, the same
   zero-new-parameter pattern this spec considered and rejected only because nothing needed writing
   yet). Nothing in PROP-027 blocks or complicates that choice.

**Unchanged:** the spec builder, all validation, the advisory dimension policy (which is what makes
1024×1024 work at all), byte inspection, SHA-256, deterministic storage paths, the materialization
service, `complete_asset_job_with_files`, `assets`, `asset_files`, the review UI, and every future
publishing consumer.

```
        ┌─── external (human + any workspace) ───┐
        │                                        │
Brief ──┼─── openai_image (API)  ────────────────┼──► IDENTICAL downstream:
        │                                        │    validate → inspect → Storage
        └─── imagen / midjourney-api / …  ───────┘    → RPC → Asset → review
```

Both executors coexist permanently — exactly as `import` and `run-api` already coexist for text.
Once PROP-028 lands, accepted-rate can be compared **by `worker_type`** (join to `asset_jobs`) or by
`assets.content.metadata.sourceKind` — **not** by `asset_job_attempts.provider`, which stays
reserved for real API-vendor identification and is null for every `external` attempt. Either
grouping still makes the eventual vendor decision evidence-based rather than a guess.

**The claim this milestone tests:** if adding an API later requires touching anything below the
executor, the provider seam was never real. PROP-027 is the proof.

---

## 9. Testing

**Unit — pure, no I/O (Node test runner, no JSX):**
- `asset-digest`: known-vector SHA-256 (must match the current `node:crypto` output byte-for-byte);
  empty and 1-byte inputs.
- `asset-generation-brief`: deterministic output; identical spec → identical `briefSha256`; any spec
  change → different hash.
- `external-asset-provider`: returns supplied bytes unchanged; performs no I/O; **scope guards** —
  no `fetch`, no Supabase import, no provider name in source (mirrors the existing scope-guard tests).
- `asset-upload-intake`: oversized, wrong MIME, undecodable, GIF, valid PNG/JPEG/WebP.
- **Dimension policy (P5) — the critical pair:**
  - 1024×1024 against a 1080×1080 spec → **accepted with a warning**.
  - declared 1080×1080 with 1024×1024 bytes → **still hard-rejected**.
- `buildResultEnvelope` emits `worker: "external"` for an external job (**P2 regression guard**).

**Integration — fake clients, no live DB:**
- Full queued → running → completed path with a real PNG fixture.
- Invalid bytes → **job stays `queued`, no attempt row** (validate-before-claim).
- Completion envelope's metadata carries `sourceWorkspace`/`sourceKind`/`briefSha256`;
  `asset_job_attempts.provider`/`.model` remain `null` (retired-P3 regression guard — nothing ever
  writes them for `external`).
- Upload fail → cleanup of current-run only; pre-existing object untouched.
- RPC fail → cleanup runs, job `failed`.
- Terminal job cannot be re-claimed.
- **Idempotency matrix (issue-4 precision):**
  - Concurrent double-tap before claim → one succeeds, the other gets `reason: "not-queued"` with a
    legible status message.
  - Retry of the upload step for the same already-claimed `{jobId, attemptNumber}` → `outcome:
    "existing"`, no duplicate row.
  - Retry after a failed terminal job → a **new** job id, a **structurally new** Storage path; no
    cross-job reuse attempted or possible.
  - Identical bytes uploaded to a different, unrelated job → two independent Storage objects, never
    deduplicated.

**Schema tests (static, against SQL source — existing convention):**
- **No new `.sql` migration file exists for this milestone** — a repo-level check that
  `supabase-add-asset-job-attempts.sql` is byte-identical to its shipped PROP-023 state.
- **`prompt` is still a disallowed column** (P4 regression guard).

**Browser tests:** this repo has no JSX-capable runner. Component behavior is therefore covered by
extracting logic into `asset-upload-intake.ts` and testing it directly. Anything left in the
component is verified by build + manual check and **must be labeled `[static]`**, matching the
precedent set by `tests/journal.test.ts`. Do not claim coverage that does not exist.

**Mobile tests — manual, and the real acceptance gate:** on a physical phone, complete
create → brief → copy → external workspace → upload → Asset visible. Repeat with a camera photo
(non-square, large). Repeat on a throttled connection to exercise retry-without-re-pick.

**Regression:** full suite green (baseline 1172/1173, 1 pre-existing skip); `npm run typecheck`;
`npm run build -- --webpack` with no new route; **no change in behavior for `mock` jobs**;
inventory/costing/baking untouched.

---

## 10. Risks, ranked

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **P1 fix silently changes hash output**, breaking deterministic storage paths and orphaning any existing object | **Critical** | Known-vector test asserting parity with current `node:crypto` output, written *before* the swap. Production currently holds 0 asset rows, so blast radius is zero today — do it now. |
| 2 | **P5 mis-fix weakens the byte-integrity check** | **Critical** | Rename both reasons first; dedicated test proving declared-vs-actual still rejects. |
| 3 | **P2 missed** → all external assets permanently stamped `mock` in the immutable freeze point | High | Envelope test asserting `worker: "external"`. |
| 4 | Browser claim/upload/completion run on an authenticated session, not a trusted server | Medium | **Explicit trust assumption:** the set of people holding valid login credentials for this Supabase project is small, known, and already trusted with full CRUD on every table — PROP-027 adds no new person to that set and no new capability beyond what an operator could already do by hand through the existing `batch-photos` path. **Explicit trigger to revisit:** the instant a credential is issued to anyone who should *not* have full CRUD on every table (a contractor, an employee without inventory/costing access) — not at a volume threshold. RLS cannot distinguish that person from the owner today. |
| 5 | `generated-assets` bucket still unverified (`STATUS.md`) | **Blocker** | Confirm via dashboard or service-role **before any work starts**. |
| 6 | PROP-027A ships, 027B slips → mobile goal unmet | High | Both authorized together; the phone acceptance test is the definition of done. |
| 7 | Operator mislabels the workspace → provenance is wrong but plausible | Low | Accepted. Self-reported provenance is the honest limit of the manual model; do not build enforcement. |
| 8 | Advisory dimensions produce off-spec assets that look wrong when published | Medium | Warning shows actual dimensions; PROP-028's review gate is the real control. |
| 9 | Attempt count understates real effort (iteration is invisible) | Low | Documented, not fixed. |
| 10 | `sourceWorkspace`/`sourceKind` are passed as a runner **option**, not derived automatically — an implementer who forgets to pass them silently ships blank provenance | Medium | A completion-path test asserting non-empty metadata specifically for `external` jobs, not merely "present if passed." |

---

## 11. Acceptance criteria

**Functional**
1. From a ready Creative Package, a `queued` Asset Job with `worker_type = "external"` can be created in the UI.
2. The brief renders and copies to clipboard; reading it performs **no** write and leaves the job `queued`.
3. A valid PNG/JPEG/WebP uploaded from the browser produces `completed` job + 1 Asset + 1 Asset File + 1 private Storage object.
4. A **1024×1024** image succeeds against the 1080×1080 spec, with a visible warning naming actual dimensions.
5. A **camera photo** (non-square, multi-MB) succeeds through the identical path.
6. An invalid file is rejected **before** claim; the job remains `queued` with **no** attempt row.
7. Re-uploading identical bytes to the **same** `{jobId, attemptNumber}` reuses the object; no duplicate Asset or File.
7b. Identical bytes uploaded to a **different** Asset Job never reuse a prior job's Storage object — each job's Asset File points to its own, independently-created object; this is by design, not a gap.
8. A failed upload can be retried **without re-selecting the file**.
9. CLI `export` and `import` produce identical results to the browser path for the same bytes.

**Provenance**
10. `asset_job_attempts.provider` and `.model` remain `null` for every `external`-worker attempt — identical to `mock` — because PROP-027 reserves them exclusively for a future real API executor (see Non-goals).
10b. `assets.content.metadata` carries `sourceWorkspace`, `sourceKind`, `briefSchemaVersion`, and `briefSha256`; **no prompt text exists anywhere in the database.**
12. `asset_jobs.result.worker = "external"` — never `"mock"`.
13. `asset_job_attempts.provider`/`.model` are the **only** fields in this subsystem that denote real API-vendor execution; `sourceWorkspace`/`sourceKind` are separately and distinctly named, and no code path ever copies one into the other.
25. A second upload attempt for a job that has already left `queued` status (concurrent double-tap, or a stale retry) is rejected with a specific, legible message naming the job's current status — never a generic error, never a silent no-op.

**Integrity (must-not-regress)**
14. Declared-vs-decoded dimension mismatch is still **rejected**.
15. SHA-256 output is **byte-identical** to the current `node:crypto` implementation for a known vector.
16. Storage paths remain deterministic and unchanged in shape.
17. `mock` job behavior is unchanged.
18. The `prompt` disallowed-column guard is intact.

**Mobile — the real gate**
19. The full flow completes **on a physical phone**, in a mobile browser, without a desktop at any step.
20. Camera roll, live camera, and the Files/Photos picker all reach the file input on a physical phone. OS-level share-sheet registration is explicitly not attempted or claimed (see Non-goals).

**Engineering hygiene**
21. `npm run typecheck` clean; scoped `eslint` clean on all new/touched files.
22. Full suite green against the 1172/1173 baseline; `npm run build -- --webpack` succeeds with no new route.
23. No package installed; no server route added; no n8n or Telegram dependency introduced.
24. No shipped SQL file is edited or added — **PROP-027 introduces zero new migrations**; provenance lives entirely in already-atomic, already-additive TypeScript/jsonb surfaces (§5).

---

## Sequencing

**PROP-027A** — P1 → P5 → P2 → P4 (metadata shape: `sourceWorkspace`/`sourceKind`/brief fingerprint —
P3 needs no work, see retired P3) → external executor → brief → CLI. Ships with real bytes proven
end to end on desktop.

**PROP-027B** — intake module → create/upload component → viewer updates → phone acceptance test.

**Do first, before either:** confirm the `generated-assets` bucket exists (risk #5), and land the
SHA-256 parity test (risk #1) before the digest swap.
