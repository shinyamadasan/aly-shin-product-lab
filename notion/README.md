# Aly & Pon OS

This folder is the Notion and business-workspace tooling area inside the Aly & Shin Product Lab repository for Aly & Pon, a coffee and bakery business built to become one of the most trusted brands in its category.

It is separate from the product app runtime, inventory system, and recipes. It contains the documentation, templates, schemas, standards, and future automation foundation that help humans and AI operate the business with consistency.

## Philosophy

- Notion is the business brain.
- Google Drive stores brand, media, legal, finance, and operating assets.
- GitHub stores documentation, templates, schemas, and automation.
- Codex maintains the repository under human direction.
- Humans approve major changes.
- Every major decision should be documented.
- The repository should be understandable to someone joining the company five years from now.

## Repository Map

| Path | Purpose |
| --- | --- |
| `docs/` | Durable business documentation and architecture notes. |
| `templates/` | Reusable document templates for decisions, SOPs, projects, and change proposals. |
| `schema/` | Notion workspace schema definitions and future seed data. |
| `automation/scripts/` | Approved automation entrypoints. |
| `automation/tests/` | Validation checks for schemas, documentation standards, and automation. |
| `AGENTS.md` | Operating rules for AI agents working in this repository. |
| `ROADMAP.md` | Sequenced plan for building the business operating system. |
| `CHANGELOG.md` | Human-readable record of meaningful repository changes. |

## Current Scope

The current repository foundation focuses on:

- Brand and operating principles.
- Documentation standards.
- Google Drive mapping.
- Notion architecture planning.
- A versioned Notion workspace schema draft.
- Templates for repeatable business documentation.

## Notion Commands

Human approval is required before running any write-capable Notion command. Dry-run is the default and does not perform live Notion writes. Run these commands from `aly-shin-product-lab/notion`.

Install:

```powershell
python -m pip install -r requirements.txt
```

Test:

```powershell
python -m unittest discover -s automation/tests -t .
```

Connectivity dry-run:

```powershell
python automation/scripts/notion_connection_test.py
```

Connectivity apply:

```powershell
python automation/scripts/notion_connection_test.py --apply
```

The script loads local `.env` values with `python-dotenv`, then reads `NOTION_TOKEN` and `NOTION_PARENT_PAGE_ID` from the process environment. Existing process environment variables are not overwritten by default. It never prints the token. In apply mode it only verifies parent-page access and idempotently creates a direct child page named `Aly & Pon Connection Test` if that page does not already exist.

Phase 1 workspace dry-run:

```powershell
python automation/scripts/build_notion_phase1.py
```

Phase 1 workspace inspect:

```powershell
python automation/scripts/build_notion_phase1.py --inspect
```

Phase 1 workspace apply:

```powershell
python automation/scripts/build_notion_phase1.py --apply
```

The Phase 1 builder reads `schema/workspace-schema.json` and may create only the approved `Areas`, `Tasks`, `Decisions`, `Meetings`, and `Approvals` databases when `--apply` is explicitly provided. Offline dry-run performs no Notion reads or writes. Inspect mode performs read-only planning. Apply mode inspects all five databases before writing, stops on hard schema conflicts, and can safely resume a partial build by adding only missing approved one-way relation properties.

Phase 2 workspace dry-run:

```powershell
python automation/scripts/bootstrap_notion_phase2.py
```

Phase 2 workspace inspect:

```powershell
python automation/scripts/bootstrap_notion_phase2.py --inspect
```

Phase 2 workspace apply:

```powershell
python automation/scripts/bootstrap_notion_phase2.py --apply
```

The Phase 2 bootstrap command transforms complete Phase 1 databases into a usable operating system shell. It may create only approved dashboard pages, database views, structural template reference pages, and starter Area records. Inspect reports Phase 1 completion, each approved view target, layout, filters, sorts, visible property configuration, and the apply endpoint. Apply performs full preflight before writing and creates database views before lower-risk bootstrap pages or starter Areas. It does not create Tasks, Meetings, Decisions, Approvals, products, recipes, vendors, inventory, marketing content, or business facts.

## Out of Scope

- Product application code.
- Inventory management.
- Recipe databases.
- Future-module Notion database creation.
- GitHub workflow changes.

## Working Agreement

Use this repository as the source of truth for architecture and operating standards. Use Notion for active business knowledge and day-to-day records once the workspace is connected. Use Google Drive for files and assets that should not live in Git.
