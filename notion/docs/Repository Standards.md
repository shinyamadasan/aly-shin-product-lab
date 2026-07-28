# Repository Standards

## Purpose

These standards keep the Aly & Pon Notion tooling area understandable, maintainable, and ready for future automation inside the Product Lab repository.

## Structure

- Keep durable business architecture in `docs/`.
- Keep reusable formats in `templates/`.
- Keep Notion schema planning in `schema/`.
- Keep future automation entrypoints in `automation/scripts/`.
- Keep validation checks in `automation/tests/`.

## Markdown Standards

- Use one `#` title per document.
- Use descriptive section headings.
- Prefer short paragraphs and tables.
- Use `TBD` when information is unknown.
- Avoid unexplained acronyms.
- Link to related documents when useful.

## Schema Standards

- Store schema files as JSON unless another format is explicitly approved.
- Include a schema version.
- Include descriptions for databases and properties.
- Do not include API tokens, workspace IDs, user IDs, or secrets.
- Treat breaking schema changes as major decisions.

## Automation Standards

- Do not add automation before the manual process is understood.
- Scripts should be documented before use.
- Tests should validate business-critical schemas and generated outputs.
- Notion-writing automation requires human approval.

## Change Standards

- Update `CHANGELOG.md` for meaningful changes.
- Update `ROADMAP.md` when direction changes.
- Add decision records for major structural choices.
- Keep unrelated formatting changes out of commits.
