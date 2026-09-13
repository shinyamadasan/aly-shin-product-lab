# Product Lab MCP Slice 1

Product Lab exposes one local stdio MCP implementation to Codex and Claude Code. Slice 1 is read-only and registers exactly two tools: `inventory_list` and `ingredient_inspect`.

## Authentication

Launch the client from a PowerShell process containing these environment variables:

```powershell
$env:PRODUCT_LAB_SUPABASE_URL = "https://<project>.supabase.co"
$env:PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY = "<publishable-or-legacy-anon-key>"
$env:PRODUCT_LAB_OWNER_ACCESS_TOKEN = Get-Clipboard
```

The owner token must be the current short-lived access token from Product Lab's normal owner sign-in. Do not put the token in `.mcp.json`, `.codex/config.toml`, a prompt, a command argument, a log, or any repository file. Close the client and remove the token from the shell when finished:

```powershell
Remove-Item Env:PRODUCT_LAB_OWNER_ACCESS_TOKEN
```

Slice 1 does not refresh expired tokens. The shared authentication boundary rejects secret/service-role project keys locally, calls `auth.getUser`, requires `app_metadata.app_role === "owner"`, and relies on database RLS for reads.

A Codex or Claude CLI launched from the prepared PowerShell inherits these variables from that
shell. An already-running VS Code, Codex Desktop, Claude Desktop, or other IDE host will not
automatically inherit variables added later in a different shell. When the owner token expires,
obtain a fresh token, update the environment that launches the client, and restart the MCP
process, client, or IDE/desktop host as appropriate. Slice 1 does not persist or refresh tokens.

## Codex

The project-scoped `.codex/config.toml` starts `node scripts/product-lab-mcp/server.ts` and forwards only the three named Product Lab environment variables. Codex loads project-scoped MCP configuration only after that exact checkout/worktree is trusted. Trust the project when Codex prompts, restart Codex from the repository root after setting the variables, then use `/mcp` to confirm `product_lab`, `inventory_list`, and `ingredient_inspect` are available. A not-yet-trusted worktree can show only user-level servers in `codex mcp list`.

## Claude Code

The project `.mcp.json` starts the same script and expands the same three environment variables at process launch. Start Claude Code from the repository root, approve the project MCP when prompted, then use `/mcp` or `claude mcp list` to confirm discovery.

`ANTHROPIC_API_KEY`, when set, can override Claude Code's saved Claude.ai login. This MCP neither reads nor depends on Anthropic credentials. Check the shell and Claude authentication state before invoking Claude; do not unset or change either authentication source implicitly.

## Tools

`inventory_list` has no input. It returns at most 500 ingredient records and reports `returned`, `total`, and `truncated`. Each record contains only ID, canonical name, active state, quantity, canonical unit, reconciliation timestamps, and nullable average unit cost.

`ingredient_inspect` accepts `{ "name": "MC Sea Salt" }`. Exact, normalized, and safe unique-alias matches return the ingredient plus at most five linked purchase records and five recent inventory movements. Movement notes are intentionally omitted. Ambiguous, suggested, inactive-alias, and unknown results disclose candidates and return no ingredient evidence. In particular, `Biscoff` never selects either Lotus Biscoff ingredient.

Both tools return facts only. They do not certify a cost or recommend a mutation.

Automated parity coverage uses two independent MCP SDK protocol clients; it proves transport and
structured-result equivalence, not Codex or Claude registration. The earlier installed-client
checks were a manual, controlled loopback rehearsal: real Codex and real Claude Code each launched
this same entry point and inspected the same fixture ingredient. No production data was accessed.

Tool failures return stable public codes and messages. Backend error text and credentials are never
returned to the MCP client; stderr receives only a safe internal error category.

Two non-blocking Slice 1 caveats are intentional. The legacy CLI's `inventory:list` output remains
a plain array and therefore does not surface MCP's `total`/`truncated` metadata when more than 500
ingredients exist. Also, MCP inspection does not load global supply history merely to enrich an
unsafe brand-history suggestion; the CLI retains that optional suggestion path. Exact, alias,
normalized, and ambiguity decisions remain shared, and neither client may act on a suggestion.

## Read-only boundary

The MCP imports only the read service. `inventory_list` performs one counted, server-limited
ingredient query. `ingredient_inspect` first loads paginated name/alias matching data, returns
immediately for an unsafe or missing match, and loads only the selected ingredient's server-limited
evidence after a safe match. It exposes no generic SQL/RPC tool and no insert, update, delete,
purchase, physical-count, certification, or order-transition tool. The existing Inventory Operator
CLI remains the separate developer/debug fallback for its guarded V1A workflow.
