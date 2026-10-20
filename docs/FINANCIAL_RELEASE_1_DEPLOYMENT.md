# Financial Release 1 production plan

Prepared 2026-10-20. **Not authorized to execute yet.** Finance is not deployed and its migration
has not been applied to production. Refund production remains `6ad77d3799debf1d75d48671`.

## Source and review

Integrate the reviewed Finance PR into main only after its recorded unit, disposable PostgreSQL,
guarded desktop/mobile browser, security and independent-review gates pass. Preserve the reviewed
commit SHA. Use a clean export of that SHA, the committed lockfile and `netlify.toml`.
Refund PR #106 and recovery/configuration PR #107 are already merged. No refund/recovery SQL is
part of this release. The original dirty Finance checkout is preserved separately.

## Exact database scope

Only `supabase/migrations/20261016120000_business_expenses.sql`: the append-only expense ledger
and its owner-only functions. It changes no existing business table or transaction. Production
already records `20261019120000` and `20261020120000`; **never execute either again**. Do not run
the incident recovery scripts again. Do not change the three recovered orders.

Migration history has older unrelated local/remote differences. Do not run an unrestricted
`supabase db push`, `migration up --include-all`, or bulk history repair. A targeted apply followed
by recording this single version avoids replaying older migrations. CLI verified: 2.120.0.

After explicit approval for both the migration and Finance deployment:

1. Confirm the approved commit and migration hash against the reviewed PR; take a database backup
   through the established Supabase backup process. Run the existing read-only
   `scripts/sql/check-refund-release-state.sql`. Require both recovery versions present, all three
   orders still completed/paid with null refund timestamp, three correction rows and one incident
   row, and no expense ledger or Finance history version. If any fact differs, stop and investigate.
2. Prepare a local SQL bundle (not a new migration): `BEGIN;`, the preflight below, the exact
   reviewed expense migration, then `COMMIT;`. Execute the whole bundle as one request using
   `supabase db query --linked --workdir . --file <bundle.sql>`. The linked project must be
   `kouesgllnyallmyesvrl`. Never send isolated fragments or continue after an error.

   ```sql
   do $$ begin
     if exists (select 1 from supabase_migrations.schema_migrations
                where version = '20261016120000') then
       raise exception 'Finance migration already recorded; stop';
     end if;
     if (select count(*) from supabase_migrations.schema_migrations
         where version in ('20261019120000','20261020120000')) <> 2 then
       raise exception 'Refund/recovery prerequisites missing; stop';
     end if;
     if to_regclass('public.business_expenses') is not null then
       raise exception 'Expense ledger already exists; inspect history instead of reapplying';
     end if;
   end $$;
   ```

3. Require successful transaction completion. Read-only postflight: ledger exists and is empty;
   RLS enabled; authenticated SELECT only and no direct writes, including service_role; owner RPC
   signatures present and private authorization checks intact. Compare the saved recovery state
   and business-record fingerprints with preflight. Run read-only database advisors and compare
   with the existing baseline. **Do not create a test expense in production.**
4. Only after SQL success and postflight, record exactly the version already applied:
   `supabase migration repair 20261016120000 --status applied --linked --workdir .`.
   Verify with `supabase migration list --linked --workdir .` and a read-only history query.
   This command records history; it does not execute the migration. If recording fails, stop and
   repair metadata after investigation; the ledger-exists guard prevents accidental reexecution.

## Netlify draft, approval and promotion

Use [the validated Linux procedure](NETLIFY_DEPLOYMENT.md): Node 24.19.0 bookworm x86_64,
`npm ci --include=optional --no-audit --no-fund`, CLI 27.10.2 and adapter 5.16.3. From the clean
reviewed source export, run the combined build/upload, keeping production environment configuration:

```sh
npx --yes netlify-cli@27.10.2 deploy --build --context production --dir .next \
  --site 07c4bd1b-638f-4103-8979-1bfe5153adde \
  --message "Financial Release 1 <approved source SHA>" --json
```

This creates a draft. Preserve source/archive hashes, deploy ID, original-case static-file hashes,
Next manifests, headers/redirects, function manifest and Linux native dependency inventory. Require
all JS/CSS URLs return 200; all server routes remain packaged. Preserve existing production env.
Do not upload source root or manually copy `.netlify/static` into the combined build's publish path.

The production-context draft shares the production database. Install `createGuardedContext` from
`scripts/qa/production-write-guard.mjs`, block service workers and all non-read app/function requests.
Verify login, Finance and expense-ledger **reads**, October coverage, September warnings, Orders,
refund confirmation without submitting, Content Studio, and desktop/mobile navigation. Cancel must
make no write request. Expense create/duplicate/void/correct and refund correction tests belong only
on disposable databases with matching migrations. The server-side fixture must also use that database.

After all draft gates pass under the separately granted release approval, promote that exact draft
atomically through Netlify Publish Deploy/API; do not rebuild. Run guarded, non-mutating production
smoke checks. Record previous deploy `6ad77d3799debf1d75d48671` as immediate rollback. Merges do not
deploy: no Git integration, build hooks, repository webhooks or deploy workflows are configured.

## Rollback

Restore the prior Netlify atomic deploy first. The additive ledger can remain without affecting
the refund application. Preserve every expense and audit record. Do not roll back the database if
any expense exists. Any schema removal requires separate human review of the migration's guarded
rollback and proof that the ledger is empty; never remove refund/recovery objects or history.

Reviewed migration SHA-256 (UTF-8 LF file): `ddd837ee7b9d3a05e4b520e035358b712584bed33f8707d655f82869fe94e6b0`. Verify this hash before apply.
