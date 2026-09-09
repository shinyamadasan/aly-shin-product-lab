# C2B-3B Live Video Activation Runbook

C2B-3A prepares this path only. Do not run these steps until independent review approves the activation delta, storage migration, auth model, signed preview security, scene-count constraint, and image-production preservation.

## Operator Credentials

- Start the workstation worker from this repository.
- Put local worker secrets in `.env.production-workers.local`.
- Required variable names are the Supabase project URL/key variables already used by the worker environment, plus the narrow `creative_worker` authentication material.
- Keep local secret files gitignored.
- Do not reuse owner credentials for the workstation worker.
- Do not use the service-role key unless an independent review documents why `creative_worker` cannot satisfy a required RPC or storage operation.

## Worker Operation

- The Remotion worker may be off. Queued `worker_type=remotion`, `asset_kind=short_video` jobs wait safely.
- Starting the worker later lets it poll, claim, render, validate, upload, materialize, and complete eligible jobs.
- Do not auto-launch the worker from the web app.
- Do not add Windows Task Scheduler management to the product.
- Stale recovery remains manual: run `npm run remotion:worker -- --recover-stuck` only as an explicit operator action.
- Do not run recovery automatically at startup and do not auto-requeue.

## C2B-3A Truthful Status

- Underlying Asset lifecycle code is asset-kind agnostic enough for video.
- Signed private-storage video preview support exists.
- Initial trusted server creation can be exercised under the reviewed activation seam.
- Owner production-card and Regenerate propagation of video activation is not proven in C2B-3A. C2B-3B must prove Produce and Regenerate both use the same trusted server-side video activation state before live owner workflow acceptance.

## Migration Preflight

Before applying `supabase-add-generated-assets-video.sql`, inspect the live `generated-assets` bucket's allowed MIME types.

Expected current set:

- `image/png`
- `image/jpeg`
- `image/webp`

If the live bucket intentionally supports any other MIME type, stop before applying the migration. The migration assigns the allowed MIME list absolutely, so applying it would remove any extra intentionally supported type.

## C2B-3B Live Proof Sequence

Critical invariant: storage and the worker must be ready before server video execution can queue jobs.

1. Verify the current production deployment and database state.
2. Inspect the live `generated-assets` bucket configuration.
3. Apply the independently reviewed `supabase-add-generated-assets-video.sql` migration.
4. Verify the bucket remains private.
5. Verify `image/png`, `image/jpeg`, `image/webp`, `video/mp4`, and the 50 MiB ceiling are configured.
6. Provision local `creative_worker` credentials for the workstation worker.
7. Verify the worker can authenticate without owner or service-role credentials.
8. Start the local Remotion worker.
9. Verify it is polling safely.
10. Deploy server code while video activation remains OFF.
11. Verify normal image production still works.
12. Enable the reviewed server-side video activation.
13. Create one controlled valid template-only Reel package with no more than two shots.
14. Owner clicks Produce.
15. Verify an Asset Job is queued with `worker_type=remotion` and `asset_kind=short_video`.
16. Verify the worker claims, renders, probes, uploads, and completes the job.
17. Verify the owner browser receives a signed private-storage preview.
18. Accept.
19. Regenerate.
20. Verify the first Asset and history remain preserved.
21. Inspect storage, database state, worker scratch cleanup, and RLS.
22. Stop for owner visual acceptance.

Technical pass is not creative acceptance. The owner must visually judge pacing, readability, composition, crop, typography, scene coverage, truncation, and rendering defects before rollout beyond the controlled proof.

## Rollback

If the controlled live proof fails, first disable server-side video activation. This stops new video Asset Jobs from being created.

Then:

- Stop the local worker if worker behavior itself is suspect.
- Inspect any queued or running `remotion + short_video` job.
- Use existing truthful stale recovery only if needed.
- Do not auto-requeue.
- Preserve completed historical Assets.
- Do not delete accepted or completed MP4s blindly.
- Inspect orphan storage through the C2B-2 reconciliation path.
- Leave image production operational.

Do not automatically revert the bucket migration after video objects have existed. Removing `video/mp4` support or shrinking the bucket policy after durable video assets exist can create a new operational mismatch. Bucket rollback must be a separate deliberate decision, and only if no durable video assets depend on it.
