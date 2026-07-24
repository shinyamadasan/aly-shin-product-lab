<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Product Lab Context

Before changing this app, read `PRODUCT_LAB_CONTEXT.md`. It is the durable source of truth for the Aly & Shin business stage, user roles, page purposes, workflow rules, known friction points, and future priorities.

For product/business decisions (costing, experiments, production, readiness, launch), use the AI review framework in `ai-review/` — start at `ai-review/README.md`.

For deterministic product-health/readiness checks (the ones that don't need AI judgment), see `RULE_ENGINE.md` and `RULES/`. The AI review framework consumes this engine's output as evidence — it never recomputes these checks itself.
