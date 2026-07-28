# Google Drive Mapping

## Purpose

Google Drive stores business assets that do not belong in GitHub. This document defines the intended folder architecture and how those assets should connect to Notion and repository documentation.

## Proposed Top-Level Folders

| Folder | Purpose | Notion Linkage |
| --- | --- | --- |
| `01 Brand` | Logos, photography, typography, packaging, brand exports. | Brand assets database. |
| `02 Operations` | SOP attachments, checklists, vendor documents, store operations files. | SOPs and vendors databases. |
| `03 Finance` | Budgets, invoices, reports, tax materials. | Finance records database. |
| `04 Legal` | Formation documents, contracts, permits, policies. | Legal records database. |
| `05 People` | Hiring assets, training files, role documents. | People and training databases. |
| `06 Marketing` | Campaign assets, content calendars, social exports. | Marketing projects database. |
| `07 Projects` | Project-specific working files and deliverables. | Projects database. |
| `99 Archive` | Deprecated or inactive assets retained for reference. | Archived records. |

## Naming Standard

Recommended format:

`YYYY-MM-DD - Descriptive Name - Version`

Examples:

- `2026-07-28 - Brand Moodboard - v1`
- `2026-07-28 - Vendor Contract - Draft`

## Rules

- Do not store secret values in Google Drive unless the correct business security controls are in place.
- Do not duplicate large binary assets in GitHub.
- Reference Google Drive assets from Notion records when those records need files.
- Keep folder names stable once Notion records depend on them.
