# Changelog

All meaningful changes to the Aly & Pon OS repository should be documented here.

The format follows a simple date-based log. This repository is currently pre-release.

## 2026-07-28

### Added

- Created the initial repository foundation for Aly & Pon OS.
- Added core business architecture documentation under `docs/`.
- Added Notion workspace planning files under `notion/`.
- Added reusable documentation templates under `templates/`.
- Added placeholders for future scripts and tests.
- Added AI agent operating instructions in `AGENTS.md`.
- Added a safe, idempotent Notion connectivity test script with dry-run default behavior.
- Added mocked tests for dry-run, environment validation, existing-page detection, page creation, API failures, and secret redaction.
- Added the minimum Notion Python client dependency declaration.
- Added `python-dotenv` so the connectivity test can load local `.env` values without exposing secrets.
- Added a dry-run-first Phase 1 Notion database builder for Areas, Tasks, Decisions, Meetings, and Approvals.
- Added mocked tests for Phase 1 builder schema validation, idempotency, conflicts, creation, and relation safety.
- Added read-only `--inspect` mode for Phase 1 Notion planning.
- Added a guarded Phase 2 workspace bootstrap command for dashboard pages, views, template reference pages, and starter Areas.
- Added mocked tests for Phase 2 dry-run, inspect, idempotency, allowed writes, and user-content preservation.

### Changed

- Expanded `README.md` from a short description into a repository guide.
- Narrowed the Phase 1 Notion schema to Areas, Tasks, Decisions, Meetings, and Approvals.
- Moved SOPs, Projects, Assets, Vendors, and Brand Standards into future-module planning.
- Updated Notion architecture and operating model documentation to match the Phase 1 schema.
- Added Notion safety rules to `AGENTS.md` and the workspace schema.
- Documented Notion connectivity setup, test, dry-run, and apply commands in `README.md`.
- Documented `.env` loading behavior for the Notion connectivity test.
- Documented Phase 1 Notion builder commands and safety behavior.
- Updated the Phase 1 builder for Notion API `2025-09-03` data source behavior.
- Improved Phase 1 builder summaries and sanitized Notion API error reporting.
- Corrected Phase 1 relation repair payloads to use one-way `single_property` relations targeting data source IDs.
- Documented Phase 2 bootstrap commands and Notion API template limitations.
- Improved Phase 2 inspect/preflight reporting for Phase 1 status, exact view definitions, conflicts, redacted IDs, and zero out-of-scope records.
- Updated Phase 2 apply ordering so view operations run before dashboard pages, template pages, and starter Areas.
- Normalized Phase 2 view comparison so omitted, `null`, and empty optional view fields do not create false conflicts.
