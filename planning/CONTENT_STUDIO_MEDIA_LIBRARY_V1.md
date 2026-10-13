# Content Studio Media Library V1

Direct owner-instructed slice, 2026-10-13. Not a formal `planning/TASK.md` milestone or AI Dev OS
queue item. Base: `origin/main`, `30881f291855fc5a827b785423e7cca09673c20f`; feature branch:
`feat/content-studio-media-library-v1`; isolated worktree: `.worktrees/content-studio-media-library-v1`.
Starting feature worktree clean. Original mobile checkout and its untracked `.netlify/` artifacts
remain untouched.

## Architecture decision: MINIMAL_NEW_MODEL

`MARKETING_MODULE.md`'s Photos and videos distinction remains binding: raw captures are source
material, completed generation-job Assets are produced artifacts. `assets.asset_job_id` is required
and unique; `asset_files` belong to that review unit. Extending those records for raw phone uploads
would require changing an existing constraint or inventing completed jobs/Creative Packages.
Neither is additive or truthful. `batch_photos` is batch-bound and uses public storage, so it also
cannot satisfy the private reusable source-library contract.

`product_media` is the small operational product-source library. Content Studio exposes its intake
and reads it; it does not take ownership of batch photos or produced Assets. Shared mechanisms:
`buildAssetUploadCandidate`, existing byte/codec inspection and per-kind limits, owner claim reader,
and `createSignedUrlForPrivateMedia`. Generated Asset semantics, schemas, and permissions are kept.

## Acceptance and verification

- Native multiple-file selection; sequential processing with individual file failures.
- JPEG/PNG/WebP ≤10 MiB and H.264 MP4 ≤50 MiB; MOV/HEVC clearly rejected, no transcoding.
- Nullable product FK; upload default and individual reassignment are owner-controlled.
- Grid, previews, Photo/Video, filename, date, All/product/Unassigned filters, session selection.
- `listMediaForProduct(client, productId)` returns shared owner-scoped source records with fresh
  preview information; `undefined` lists All and `null` lists Unassigned. Explicit client injection
  matches existing repository APIs. A future recipe consumer can use the saved IDs and this seam.
- Private bucket and owner-role RLS; co-owners share business records. `created_by` is audit only.
  Public ordering accounts, unrelated accounts, workers, and anonymous callers are excluded.
- No media delete/overwrite permission. Only `product_id` can be updated. Product deletion sets
  association null and retains media. Selection is local to the mounted Media view, not usage.
- Ambiguous post-upload registration failure retains its private object and asks for reload.
  An unregistered object may need later operator recovery; V1 offers no automatic orphan cleanup.
- Codec validation reuses the browser intake. Storage enforces MIME/size and policies, not codec
  decoding against a malicious direct API caller; no claim of server-side H.264 inspection.

Verification commands:

```powershell
node --test tests/product-media.test.ts tests/asset-upload-intake.test.ts tests/asset-video-binary.test.ts tests/assets.test.ts tests/asset-ui.test.ts tests/creative-package-asset-create.test.ts tests/owner-data-rls-hardening.test.ts
$env:RUN_POSTGRES_SMOKE='1'
node --test tests/smoke/postgres/product-media-library.smoke.test.ts
node tests/smoke/browser/product-media-library.smoke.mjs
npm test
npm run typecheck
npm run build
```

The browser harness uses the real component/upload code with local row/storage adapters and
short-lived signed fixture previews. PostgreSQL smoke independently executes the real migration,
claim readers, grants, and RLS against disposable auth/storage schema stubs. It persists three
photos and one video under a test Product and reads them from fresh connections. This is local
technical acceptance, not a live Supabase/phone acceptance claim. Synthetic FFmpeg test patterns
are not production bakery media. Screenshots and run output: `outputs/media-acceptance/` (ignored).

## Rollout gate

Migration: `supabase/migrations/20261013090000_product_media_library_v1.sql`. Additive and transactional,
with prerequisite/reapplication guards. Production application needs separate authorization;
do not `db push` across the known history drift. Inspect prerequisites, existing storage policies,
and bucket limits in the authorized target, then review/apply only this migration. Verify signed
preview and all role boundaries in that environment before uploading owner bakery media.

No deploy, merge, production migration, real owner upload, recipe automation, composition, AI tags,
usage tracking, publishing, scheduling, price/offer inference, or unrelated subsystem edits.
MOV/HEVC support remains a follow-up. Real iOS Safari/Android Chrome feel and device rendering
remain human acceptance items. Merge gate: `approved`, after human review.

Final local verification: focused **97/97**, full suite **4407 passed, 0 failed, 1 existing
platform-specific skip**; PostgreSQL smoke **PASS**; browser fixture acceptance **PASS** at
320/375/390/1280; scoped lint **PASS**; standalone typecheck **PASS**; Next production build **PASS**.
Self-review and QA verdict are recorded in REVIEW; production rollout remains explicitly pending.
