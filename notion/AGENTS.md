# AGENTS.md

This file defines how AI agents should work inside the Aly & Pon Notion tooling area of the Product Lab repository.

## Mission

Maintain the documentation and architecture foundation for Aly & Pon. This tooling area exists to make business knowledge durable, understandable, and ready for future Notion and automation integration.

## Non-Negotiables

- Do not build the product app.
- Do not build inventory.
- Do not build recipes.
- Do not write Notion API code until explicitly requested.
- Do not install dependencies unless explicitly requested.
- Do not modify `.env`.
- Do not change GitHub workflows unless explicitly requested.
- Do not invent business facts. Mark unknowns clearly.
- Never delete or archive Notion content automatically.
- Never expose secrets.

## Operating Principles

- Prefer clear documentation over clever automation.
- Keep changes surgical and directly tied to the request.
- Preserve human readability for someone joining the company years later.
- Document major decisions before implementing structural changes.
- Keep schemas versioned and explain breaking changes.
- Treat Notion as the business brain, Google Drive as the asset store, and GitHub as the source for standards, templates, schemas, and automation.
- Dry-run is the default for write-capable commands.
- Live writes require an explicit `--apply` flag.
- Operations must be idempotent.
- Stop on unexpected live-schema conflicts.
- Seed data is not approved unless explicitly marked approved.

## Change Process

1. Inspect the repository before editing.
2. State assumptions when scope is ambiguous.
3. Make the smallest change that satisfies the request.
4. Update `CHANGELOG.md` for meaningful repository changes.
5. Update `ROADMAP.md` when priorities or phases change.
6. Verify files are present and structurally valid.

## Documentation Standards

- Use Markdown for durable documentation.
- Use clear titles, short sections, and direct language.
- Prefer tables for mappings and ownership.
- Use `TBD` for unknown information instead of guessing.
- Put reusable formats in `templates/`.
- Put source-of-truth business architecture in `docs/`.

## Human Approval

Human approval is required before:

- Connecting to Notion.
- Writing to Notion through an API.
- Adding dependencies.
- Changing repository workflows.
- Introducing automation that modifies business records.
- Removing or renaming core documentation structures.
