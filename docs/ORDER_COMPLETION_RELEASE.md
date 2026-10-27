# Order completion release runbook (PR #114)

Controlled release of the MCP order completion tools and the checked-fulfillment guard. Every gate
marked **APPROVAL** needs an explicit owner instruction for that gate; approval of one gate does not
carry to the next. Design and evidence: [PRODUCT_LAB_MCP.md](PRODUCT_LAB_MCP.md) "Order completion
tools"; review log: REVIEW.md 2026-10-27.

## Release identities (prepared 2026-10-27)

| Item | Expected value |
| --- | --- |
| Base | `origin/main` = `bbd679d76a6e6fa5a0ceda8039c0f41a939ee59e` (no drift) |
| Migration | `supabase/migrations/20261027120000_order_fulfillment_expected_state_guard.sql`, SHA-256 `c152684c36ed01c813f73e876ddcf2b2c3b69fd485ddac26df4119715304e781` |
| Preflight (read only) | `supabase-check-order-fulfillment-guard.sql` -- passed in production per owner, 2026-10-27 |
| Postflight (read only) | `supabase-check-order-fulfillment-guard-postflight.sql` -- every row `ok = t` |
| Legacy body md5 after apply | `90fa29932fe66108b0e50ef6008e9706` (before: Wave 2 `f11078872e13ecc80cb6c0b571fdc11d`) |
| Worker bundle | `index.js` SHA-256 `f731a3fb9527026b19cceb0524253a39ca399ea4fd37350c74251ff4f414d15d`, 2038.30 KiB |
| Worker now (rollback target) | version `c4750fda-3386-45db-923c-343a7f142703` (the #113 build; not vulnerable) |
| Netlify now | deploy `6ad80999372256dd5f17e529`; site has **no linked repository** |

Merging does not deploy anything: Netlify is unlinked, the repository has no GitHub Actions, and no
integration posted a status or deployment for the nine merges to main since 2026-10-16 (the Vercel
GitHub app last deployed 2026-10-15). The Vercel project's connection was not inspected directly.

## Gate 0 -- readiness re-check (automatic, read only; repeat immediately before Gate 1)

```powershell
git fetch origin
git rev-parse origin/main                     # must still be bbd679d...; otherwise stop and re-verify
gh pr view 114 --json headRefOid,mergeable,mergeStateStatus
```

## Gate 1 -- merge PR #114 (APPROVAL)

```powershell
gh pr ready 114
gh pr merge 114 --merge                       # merge commit; tree identical to the PR head
git fetch origin; git diff <pr-head> origin/main --stat   # must be empty
```

Postcheck (automatic): Netlify published deploy and Worker version unchanged (no auto-deploy).

## Gate 2 -- apply the migration (APPROVAL + owner-supplied production connection)

Claude has no production database credentials and must not hold them unless you provide a connection
for this gate. Follow the house procedure used for Financial Release 2:

1. Re-run the preflight (read only); expect the same four results that passed.
2. Take the normal protected backup and record migration history.
3. Verify the file hash, then apply in one fail-on-error transaction:

```powershell
(Get-FileHash supabase/migrations/20261027120000_order_fulfillment_expected_state_guard.sql -Algorithm SHA256).Hash
psql "<approved-connection>" -X -v ON_ERROR_STOP=1 --single-transaction -f supabase/migrations/20261027120000_order_fulfillment_expected_state_guard.sql
npx --yes supabase@2.121.0 migration repair 20261027120000 --status applied --db-url "<approved-connection>"
```

The migration writes no rows. Its only live behavior change for the web app: completing an order
whose reserved lot is short is refused instead of driving the lot negative. Owners do not need to
pause stock work for it, but should not complete orders during the few seconds of the transaction.

## Gate 3 -- verify the database (read only; automatic if a read-only connection is supplied, else owner in the SQL editor)

- `supabase-check-order-fulfillment-guard-postflight.sql`: all nine rows `ok = t`.
- `select version from supabase_migrations.schema_migrations where version = '20261027120000';` -> one row.
- Owner opens Orders in the web app (read only). No test completion in production.

Any `f`: stop, do not deploy the Worker, and decide on the header rollback.

## Gate 4 -- deploy the Worker (APPROVAL)

From the merged main in a clean worktree, with existing bindings (no `--var`, no secret change):

```powershell
npm ci
npm run product-lab:mcp:worker:dry-run
(Get-FileHash .wrangler/dry-run/index.js -Algorithm SHA256).Hash   # must equal f731a3fb...d15d
npx wrangler deploy --config wrangler.product-lab-mcp.jsonc --keep-vars --message "Order completion guard <merge-sha>"
# --keep-vars as in the 2026-10-20 release: never delete dashboard-set vars. The three settings are secrets.
npx wrangler deployments list --config wrangler.product-lab-mcp.jsonc   # record the new version id
```

## Gate 5 -- verify the nine tools

Automatic (no credentials): discovery documents served; unauthenticated `POST /api/mcp` -> 401 with
the RFC 9728 challenge; the deployed module downloaded read-only from the Cloudflare API hashes to
`f731a3fb...d15d`.

Owner (needs an owner OAuth session, e.g. Claude Code `/mcp` -> reconnect `product-lab`): tools list
shows exactly nine tools; run `order_inspect` with no arguments (read only). Completing a real order is
a separate approval naming that order.

## Rollback

| Problem | Action (APPROVAL) | Effect |
| --- | --- | --- |
| Worker misbehaves | `npx wrangler rollback c4750fda-3386-45db-923c-343a7f142703 --config wrangler.product-lab-mcp.jsonc -m "<reason>"` | Back to the five #113 tools; the database guard stays and is harmless |
| Guard must be removed | Roll back the Worker first, then run the migration header's rollback | Exact Wave 2 body restored (proven against PostgreSQL by the smoke suite) |
| Merge must be undone | `git revert -m 1 <merge-sha>` via PR | No runtime effect; nothing deploys from main |

Not in this release: Netlify deploy, ChatGPT OAuth client, user-global Claude ask rules (each owner's
own `~/.claude/settings.json`), pushing `docs/mcp-security-release-checkpoint`.
