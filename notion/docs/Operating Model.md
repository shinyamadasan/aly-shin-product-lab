# Operating Model

## Purpose

This document explains how Aly & Pon uses systems to manage business knowledge, decisions, assets, and future automation.

## System Roles

| System | Role |
| --- | --- |
| Notion | Business brain for active knowledge, areas, tasks, decisions, meetings, approvals, and operating records. |
| Google Drive | Asset store for files such as images, documents, contracts, exports, and media. |
| GitHub | Source of truth for documentation, templates, schemas, standards, and automation. |
| Codex | Repository maintainer that proposes and implements changes under human direction. |

## Governance Model

- Humans approve major business and architecture changes.
- Codex may maintain documentation, schemas, and automation when asked.
- Major decisions should be recorded before they become operating policy.
- Business-critical records should have an owner and review cadence.

## Phase 1 Knowledge Flow

1. Work is assigned to an accountable Area.
2. Tasks capture what needs to happen, who owns it, priority, due date, and whether approval is required.
3. Meetings capture notes and reference resulting Tasks or Decisions.
4. Decisions capture the reason, summary, approvers, and revisit date.
5. Approvals capture human review for Tasks or Decisions that require signoff.
6. Repository documentation is updated when approved decisions change business architecture.
7. Notion is updated manually today, and by controlled automation in the future.

## Operating Areas

Initial operating areas:

- Brand.
- Operations.
- People.
- Finance.
- Vendors.
- Projects.
- Decisions.
- Assets.
- Standards.

Product application, inventory, and recipes are intentionally excluded from this foundation.

## Phase 1 Notion Scope

Phase 1 contains only:

- Areas.
- Tasks.
- Decisions.
- Meetings.
- Approvals.

SOPs, Projects, Assets, Vendors, and Brand Standards remain important future modules, but they are not part of the Phase 1 workspace schema.

## Automation Safety

Future automation must default to dry-run behavior. Live writes require an explicit `--apply` flag, must be idempotent, must never expose secrets, and must stop on unexpected live-schema conflicts. No automation may delete or archive Notion content automatically.

The current Notion automation scope is limited to a connectivity test. It may only verify access to the configured parent page and, in explicit apply mode, idempotently create one direct child page named `Aly & Pon Connection Test`.

The Phase 1 database builder is also approved as a guarded command. In dry-run it validates the environment and schema without contacting Notion. In inspect mode it reads live Notion state but performs no writes. In explicit apply mode it may create only the five approved Phase 1 databases under the configured parent page or repair missing approved one-way relation properties. It must inspect all five databases before any write and stop before writing if an existing same-title database has a hard schema conflict.

The Phase 2 bootstrap command may add the workspace shell once Phase 1 is complete. It creates no business facts beyond the approved starter Area names. It must preserve user-created content by matching existing pages, views, and Area records by title and creating only missing approved items. Apply creates database views first so unsupported view payloads fail before dashboard pages, template reference pages, or starter Areas are created.
