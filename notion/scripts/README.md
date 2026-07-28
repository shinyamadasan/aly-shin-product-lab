# Scripts

This folder stores approved automation entrypoints.

`notion_connection_test.py` is a minimal Notion connectivity test. It loads local `.env` values with `python-dotenv` before reading the process environment. Dry-run is the default. Live writes require `--apply` and are limited to idempotently creating one direct child page named `Aly & Pon Connection Test`.

`build_notion_phase1.py` builds or repairs the approved Phase 1 Notion databases from `notion/workspace-schema.json`. Dry-run is the default and performs no Notion reads or writes. `--inspect` performs read-only live planning. Live writes require `--apply` and are limited to the `Areas`, `Tasks`, `Decisions`, `Meetings`, and `Approvals` databases plus their approved one-way relation properties.

Relation repairs use `PATCH /v1/data_sources/{data_source_id}` and send relation properties with `type: relation`, the target `relation.data_source_id`, and `relation.single_property: {}`. The script does not add `dual_property` or reciprocal properties unless the schema explicitly defines them.

Commands:

```powershell
python scripts/build_notion_phase1.py
python scripts/build_notion_phase1.py --inspect
python scripts/build_notion_phase1.py --apply
```

`bootstrap_notion_phase2.py` adds the approved Phase 2 workspace shell. Dry-run is offline, `--inspect` is read-only, and live writes require `--apply`. It creates only missing dashboard pages, database views, template reference pages, and starter Area records.

Inspect reports all five Phase 1 databases, approved view target IDs in shortened form, layout, filters, sorts, visible properties, matching/missing/conflict status, and zero planned records for Tasks, Decisions, Meetings, Approvals, products, recipes, vendors, inventory, and marketing content. Apply performs a complete preflight first and creates views before other bootstrap content.

View comparison normalizes optional empty API values before comparison. Missing, `null`, and `[]` all mean no sorts or visible/display properties; missing and `null` mean no filter. Non-empty differences still conflict.

Commands:

```powershell
python scripts/bootstrap_notion_phase2.py
python scripts/bootstrap_notion_phase2.py --inspect
python scripts/bootstrap_notion_phase2.py --apply
```

Future scripts may include:

- Schema validation.
- Documentation checks.
- Controlled Notion sync after approval.
