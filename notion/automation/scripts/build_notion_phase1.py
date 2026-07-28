"""Build or repair the approved Phase 1 Notion databases for Aly & Pon OS."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Protocol

from dotenv import load_dotenv


NOTION_API_VERSION = "2025-09-03"
APPROVED_DATABASES = ["Areas", "Tasks", "Decisions", "Meetings", "Approvals"]
SUPPORTED_PROPERTY_TYPES = {"title", "select", "people", "rich_text", "date", "relation", "checkbox"}
REQUIRED_ENV_VARS = ("NOTION_TOKEN", "NOTION_PARENT_PAGE_ID")
PAGE_ID_RE = re.compile(
    r"^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"
)
ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "schema" / "workspace-schema.json"


class NotionClient(Protocol):
    pages: Any
    blocks: Any

    def request(
        self,
        path: str,
        method: str,
        query: dict[Any, Any] | None = None,
        body: dict[Any, Any] | None = None,
        auth: str | None = None,
    ) -> Any:
        ...


@dataclass
class DatabaseState:
    name: str
    database_id: str
    data_source_id: str
    schema: dict[str, Any]


@dataclass
class Plan:
    existing: dict[str, DatabaseState] = field(default_factory=dict)
    missing_databases: list[str] = field(default_factory=list)
    missing_relations: dict[str, list[str]] = field(default_factory=dict)
    complete: list[str] = field(default_factory=list)
    incomplete: list[str] = field(default_factory=list)
    conflicts: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class BuildResult:
    exit_code: int = 0
    messages: list[str] = field(default_factory=list)
    containers_created: list[str] = field(default_factory=list)
    relations_added: list[str] = field(default_factory=list)
    complete: list[str] = field(default_factory=list)
    incomplete: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)


def redact_secret(value: str | None) -> str:
    return "<redacted>" if value else "<missing>"


def short_id(value: str) -> str:
    clean = value.replace("-", "")
    if len(clean) <= 8:
        return "<redacted-id>"
    return f"{clean[:4]}...{clean[-4:]}"


def validate_env(env: Mapping[str, str]) -> tuple[dict[str, str], list[str]]:
    errors: list[str] = []
    values: dict[str, str] = {}
    for key in REQUIRED_ENV_VARS:
        value = env.get(key, "").strip()
        if value:
            values[key] = value
        else:
            errors.append(f"Missing required environment variable: {key}")
    parent_page_id = values.get("NOTION_PARENT_PAGE_ID")
    if parent_page_id and not PAGE_ID_RE.match(parent_page_id):
        errors.append("NOTION_PARENT_PAGE_ID must be a 32-character Notion page ID, with or without hyphens.")
    return values, errors


def load_notion_client(token: str) -> NotionClient:
    from notion_client import Client

    return Client(auth=token, notion_version=NOTION_API_VERSION)


def rich_text_plain_text(items: list[dict[str, Any]]) -> str:
    return "".join(item.get("plain_text", "") for item in items)


def load_workspace_schema(path: Path = SCHEMA_PATH) -> tuple[dict[str, Any] | None, list[str]]:
    try:
        schema = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return None, [f"Malformed workspace schema JSON: {exc.msg} at line {exc.lineno}, column {exc.colno}."]
    except OSError as exc:
        return None, [f"Could not read workspace schema: {exc.__class__.__name__}."]
    return schema, validate_workspace_schema(schema)


def validate_workspace_schema(schema: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    databases = schema.get("databases")
    status_systems = schema.get("statusSystems", {})
    if not isinstance(databases, list):
        return ["workspace-schema.json must contain a databases list."]
    active_names = [database.get("name") for database in databases]
    if active_names != APPROVED_DATABASES:
        errors.append("Active Phase 1 databases must be exactly, in order: " + ", ".join(APPROVED_DATABASES) + ".")
    approved_set = set(APPROVED_DATABASES)
    for database in databases:
        name = database.get("name", "<unnamed>")
        if name not in approved_set:
            errors.append(f"Unexpected active database is not approved for Phase 1: {name}")
        properties = database.get("properties")
        if not isinstance(properties, list):
            errors.append(f"{name} must define a properties list.")
            continue
        title_count = 0
        for prop in properties:
            prop_name = prop.get("name", "<unnamed>")
            prop_type = prop.get("type")
            if prop_type not in SUPPORTED_PROPERTY_TYPES:
                errors.append(f"{name}.{prop_name} uses unsupported property type: {prop_type}")
                continue
            if prop_type == "title":
                title_count += 1
            if prop_type == "select" and "optionsRef" in prop and prop["optionsRef"] not in status_systems:
                errors.append(f"{name}.{prop_name} references unknown optionsRef: {prop['optionsRef']}")
            if prop_type == "relation" and prop.get("relatedDatabase") not in approved_set:
                errors.append(f"{name}.{prop_name} relates to unapproved database: {prop.get('relatedDatabase')}")
        if title_count != 1:
            errors.append(f"{name} must define exactly one title property.")
    return errors


def select_options(prop: dict[str, Any], schema: dict[str, Any]) -> list[str]:
    return prop["options"] if "options" in prop else schema["statusSystems"][prop["optionsRef"]]


def notion_property_payload(
    prop: dict[str, Any],
    schema: dict[str, Any],
    data_source_ids: Mapping[str, str],
) -> dict[str, Any]:
    prop_type = prop["type"]
    if prop_type == "title":
        return {"title": {}}
    if prop_type in {"rich_text", "people", "date", "checkbox"}:
        return {prop_type: {}}
    if prop_type == "select":
        return {"select": {"options": [{"name": option} for option in select_options(prop, schema)]}}
    if prop_type == "relation":
        related_name = prop["relatedDatabase"]
        if related_name not in data_source_ids:
            raise ValueError(f"Relation target is not available: {related_name}")
        relation: dict[str, Any] = {"data_source_id": data_source_ids[related_name]}
        if "dual_property" in prop:
            relation["dual_property"] = prop["dual_property"]
        else:
            relation["single_property"] = {}
        return {"type": "relation", "relation": relation}
    raise ValueError(f"Unsupported property type: {prop_type}")


def properties_payload(
    database: dict[str, Any],
    schema: dict[str, Any],
    data_source_ids: Mapping[str, str],
    *,
    include_relations: bool,
) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for prop in database["properties"]:
        if (prop["type"] == "relation") != include_relations:
            continue
        payload[prop["name"]] = notion_property_payload(prop, schema, data_source_ids)
    return payload


def normalized_live_property(prop: dict[str, Any]) -> dict[str, Any]:
    prop_type = prop.get("type")
    actual: dict[str, Any] = {"type": prop_type}
    if prop_type == "select":
        actual["options"] = [option.get("name") for option in prop.get("select", {}).get("options", [])]
    if prop_type == "relation":
        relation = prop.get("relation", {})
        actual["relation_type"] = relation.get("type")
        actual["data_source_id"] = relation.get("data_source_id")
        actual["database_id"] = relation.get("database_id")
    return actual


def data_sources_from_container(container: dict[str, Any]) -> list[dict[str, Any]]:
    return container.get("data_sources") or container.get("dataSources") or []


def primary_data_source_id(container: dict[str, Any]) -> str:
    data_sources = data_sources_from_container(container)
    if not data_sources:
        raise ValueError("Database container response did not include a primary data source.")
    return data_sources[0]["id"]


def retrieve_database_container(client: NotionClient, database_id: str) -> dict[str, Any]:
    return client.request(f"databases/{database_id}", "GET")


def retrieve_data_source(client: NotionClient, data_source_id: str) -> dict[str, Any]:
    return client.request(f"data_sources/{data_source_id}", "GET")


def update_data_source_properties(client: NotionClient, data_source_id: str, properties: dict[str, Any]) -> dict[str, Any]:
    return client.request(f"data_sources/{data_source_id}", "PATCH", body={"properties": properties})


def create_database_without_relations(
    client: NotionClient,
    parent_page_id: str,
    database: dict[str, Any],
    schema: dict[str, Any],
) -> dict[str, Any]:
    return client.request(
        "databases",
        "POST",
        body={
            "parent": {"type": "page_id", "page_id": parent_page_id},
            "title": [{"type": "text", "text": {"content": database["name"]}}],
            "initial_data_source": {
                "properties": properties_payload(database, schema, {}, include_relations=False)
            },
        },
    )


def list_direct_child_database_containers(client: NotionClient, parent_page_id: str) -> dict[str, dict[str, Any]]:
    child_databases: dict[str, dict[str, Any]] = {}
    cursor: str | None = None
    while True:
        kwargs: dict[str, Any] = {"block_id": parent_page_id, "page_size": 100}
        if cursor:
            kwargs["start_cursor"] = cursor
        response = client.blocks.children.list(**kwargs)
        for child in response.get("results", []):
            if child.get("type") != "child_database":
                continue
            database_id = child.get("id")
            if not database_id:
                continue
            container = retrieve_database_container(client, database_id)
            title = rich_text_plain_text(container.get("title", [])) or child.get("child_database", {}).get("title", "")
            if title:
                child_databases[title] = container
        if not response.get("has_more"):
            return child_databases
        cursor = response.get("next_cursor")


def inspect_workspace(client: NotionClient, parent_page_id: str, schema: dict[str, Any]) -> Plan:
    containers = list_direct_child_database_containers(client, parent_page_id)
    states: dict[str, DatabaseState] = {}
    for name in APPROVED_DATABASES:
        if name not in containers:
            continue
        container = containers[name]
        data_source_id = primary_data_source_id(container)
        data_source = retrieve_data_source(client, data_source_id)
        states[name] = DatabaseState(
            name=name,
            database_id=container["id"],
            data_source_id=data_source_id,
            schema=data_source,
        )
    return build_plan(schema, states)


def build_plan(schema: dict[str, Any], states: dict[str, DatabaseState]) -> Plan:
    plan = Plan(existing=states)
    data_source_ids = {name: state.data_source_id for name, state in states.items()}

    for expected in schema["databases"]:
        name = expected["name"]
        state = states.get(name)
        if not state:
            plan.missing_databases.append(name)
            plan.incomplete.append(name)
            continue
        missing_relations, conflicts = compare_data_source_schema(expected, state.schema, schema, data_source_ids)
        if conflicts:
            plan.conflicts[name] = conflicts
        elif missing_relations:
            plan.missing_relations[name] = missing_relations
            plan.incomplete.append(name)
        else:
            plan.complete.append(name)
    return plan


def compare_data_source_schema(
    expected_database: dict[str, Any],
    live_schema: dict[str, Any],
    schema: dict[str, Any],
    data_source_ids: Mapping[str, str],
) -> tuple[list[str], list[str]]:
    missing_relations: list[str] = []
    conflicts: list[str] = []
    live_properties = live_schema.get("properties", {})
    expected_names = [prop["name"] for prop in expected_database["properties"]]

    for name in live_properties:
        if name not in expected_names:
            conflicts.append(f"- Unexpected property: {name}")

    for prop in expected_database["properties"]:
        name = prop["name"]
        if name not in live_properties:
            if prop["type"] == "relation":
                missing_relations.append(name)
            else:
                conflicts.append(f"- Missing non-relation property: {name}")
            continue
        actual = normalized_live_property(live_properties[name])
        if actual["type"] != prop["type"]:
            conflicts.append(f"- Property type mismatch for {name}: expected {prop['type']}, found {actual['type']}")
            continue
        if prop["type"] == "select":
            expected_options = select_options(prop, schema)
            if actual.get("options") != expected_options:
                conflicts.append(f"- Select options mismatch for {name}: expected {expected_options}, found {actual.get('options')}")
        if prop["type"] == "relation":
            related_name = prop["relatedDatabase"]
            expected_data_source_id = data_source_ids.get(related_name)
            expected_relation_type = "dual_property" if "dual_property" in prop else "single_property"
            if not expected_data_source_id:
                conflicts.append(f"- Relation target for {name} cannot be resolved yet: {related_name}")
            elif actual.get("data_source_id") != expected_data_source_id:
                conflicts.append(f"- Relation target mismatch for {name}: expected {related_name}, found another data source")
            elif actual.get("relation_type") != expected_relation_type:
                conflicts.append(f"- Relation mode mismatch for {name}: expected {expected_relation_type}, found {actual.get('relation_type')}")
    return missing_relations, conflicts


def api_error_message(exc: Exception, operation: str) -> str:
    status = getattr(exc, "status", None) or getattr(exc, "status_code", None)
    code = getattr(exc, "code", None)
    message = getattr(exc, "message", None) or str(exc)
    sanitized = re.sub(r"secret_[A-Za-z0-9_:-]+", "<redacted>", message)
    return (
        f"Notion API operation failed during {operation}: "
        f"status={status or 'unknown'} code={code or 'unknown'} message={sanitized}"
    )


def append_plan_messages(result: BuildResult, plan: Plan, *, inspect: bool) -> None:
    if inspect:
        for name, state in plan.existing.items():
            result.messages.append(
                f"{name}: database_id={short_id(state.database_id)} data_source_id={short_id(state.data_source_id)}"
            )
    result.messages.append("complete: " + (", ".join(plan.complete) if plan.complete else "none"))
    result.messages.append("incomplete: " + (", ".join(plan.incomplete) if plan.incomplete else "none"))
    if plan.missing_databases:
        result.messages.append("missing database containers: " + ", ".join(plan.missing_databases))
    for name, relations in plan.missing_relations.items():
        result.messages.append(f"{name} missing approved relations: " + ", ".join(relations))
    for name, conflicts in plan.conflicts.items():
        result.messages.append(f"Schema conflict for {name}:")
        result.messages.extend(conflicts)
    if inspect:
        result.messages.append("Inspect mode: zero writes performed.")
        result.messages.append(
            "Apply mode would create no new database containers."
            if not plan.missing_databases
            else "Apply mode would create missing approved database containers."
        )


def apply_plan(
    client: NotionClient,
    parent_page_id: str,
    schema: dict[str, Any],
    plan: Plan,
    result: BuildResult,
) -> BuildResult:
    if plan.conflicts:
        result.conflicts = list(plan.conflicts)
        result.messages.append("Stopped before writes because hard schema conflicts were found.")
        append_plan_messages(result, plan, inspect=False)
        result.messages.extend(summary_messages(result))
        result.exit_code = 1
        return result

    states = dict(plan.existing)
    data_source_ids = {name: state.data_source_id for name, state in states.items()}

    for database in schema["databases"]:
        name = database["name"]
        if name in states:
            continue
        created = create_database_without_relations(client, parent_page_id, database, schema)
        data_source_id = primary_data_source_id(created)
        data_source = retrieve_data_source(client, data_source_id)
        states[name] = DatabaseState(name, created["id"], data_source_id, data_source)
        data_source_ids[name] = data_source_id
        result.containers_created.append(name)

    repair_plan = build_plan(schema, states)
    if repair_plan.conflicts:
        result.conflicts = list(repair_plan.conflicts)
        result.failed = list(repair_plan.conflicts)
        result.messages.append("Stopped after container creation because relation planning found hard conflicts.")
        append_plan_messages(result, repair_plan, inspect=False)
        result.messages.extend(summary_messages(result))
        result.exit_code = 1
        return result

    for database in schema["databases"]:
        name = database["name"]
        missing_relations = repair_plan.missing_relations.get(name, [])
        if not missing_relations:
            continue
        relation_props = [
            prop for prop in database["properties"] if prop["type"] == "relation" and prop["name"] in missing_relations
        ]
        payload = {prop["name"]: notion_property_payload(prop, schema, data_source_ids) for prop in relation_props}
        result.messages.append(
            f"Adding approved relations to {name} ({short_id(states[name].data_source_id)}): "
            + ", ".join(missing_relations)
        )
        update_data_source_properties(client, states[name].data_source_id, payload)
        for relation_name in missing_relations:
            result.relations_added.append(f"{name}.{relation_name}")
        result.messages.append(f"Added approved relations to {name}: " + ", ".join(missing_relations))

    final_states: dict[str, DatabaseState] = {}
    for name, state in states.items():
        final_states[name] = DatabaseState(
            name=name,
            database_id=state.database_id,
            data_source_id=state.data_source_id,
            schema=retrieve_data_source(client, state.data_source_id),
        )
    final_plan = build_plan(schema, final_states)
    result.complete = final_plan.complete
    result.incomplete = final_plan.incomplete
    result.conflicts = list(final_plan.conflicts)
    result.unchanged = [name for name in final_plan.complete if name not in result.containers_created and not any(item.startswith(f"{name}.") for item in result.relations_added)]

    if final_plan.conflicts or final_plan.incomplete:
        result.exit_code = 1
        result.failed = list(final_plan.conflicts) + final_plan.incomplete
    result.messages.extend(summary_messages(result))
    return result


def run_build(
    env: Mapping[str, str],
    *,
    apply: bool = False,
    inspect: bool = False,
    client: NotionClient | None = None,
    schema_path: Path = SCHEMA_PATH,
) -> BuildResult:
    result = BuildResult()
    if apply and inspect:
        return BuildResult(exit_code=1, messages=["Use only one mode: --inspect or --apply."])

    values, env_errors = validate_env(env)
    schema, schema_errors = load_workspace_schema(schema_path)
    if env_errors or schema_errors or schema is None:
        result.exit_code = 1
        result.messages.extend(env_errors)
        result.messages.extend(schema_errors)
        return result

    token = values["NOTION_TOKEN"]
    parent_page_id = values["NOTION_PARENT_PAGE_ID"]
    result.messages.append("Required environment variables are present.")
    result.messages.append("NOTION_PARENT_PAGE_ID format is valid.")
    result.messages.append(f"NOTION_TOKEN: {redact_secret(token)}")
    result.messages.append("workspace-schema.json is valid for Phase 1.")
    result.messages.append("Creation order: " + ", ".join(APPROVED_DATABASES))
    for database in schema["databases"]:
        result.messages.append(f"{database['name']} properties:")
        for prop in database["properties"]:
            detail = prop["type"]
            if prop["type"] == "select":
                detail += " [" + ", ".join(select_options(prop, schema)) + "]"
            if prop["type"] == "relation":
                detail += f" -> {prop['relatedDatabase']}"
            result.messages.append(f"- {prop['name']}: {detail}")

    if not apply and not inspect:
        result.messages.append("Dry-run mode: no live Notion reads or writes will be performed.")
        result.messages.append("Inspect mode would verify parent-page access and classify the five approved databases without writing.")
        result.messages.append("Apply mode would inspect first, stop on hard conflicts, and then create only missing containers or missing approved relations.")
        return result

    notion = client if client is not None else load_notion_client(token)
    try:
        notion.pages.retrieve(page_id=parent_page_id)
        result.messages.append("Configured parent page is accessible.")
        plan = inspect_workspace(notion, parent_page_id, schema)
        if inspect:
            append_plan_messages(result, plan, inspect=True)
            result.exit_code = 1 if plan.conflicts else 0
            return result
        return apply_plan(notion, parent_page_id, schema, plan, result)
    except Exception as exc:
        result.exit_code = 1
        result.failed.append("Notion API")
        result.messages.append(api_error_message(exc, "Phase 1 workspace planning/apply"))
        result.messages.extend(summary_messages(result))
        return result


def summary_messages(result: BuildResult) -> list[str]:
    return [
        "Final summary:",
        "containers created: " + (", ".join(result.containers_created) if result.containers_created else "none"),
        "relations added: " + (", ".join(result.relations_added) if result.relations_added else "none"),
        "complete: " + (", ".join(result.complete) if result.complete else "none"),
        "incomplete: " + (", ".join(result.incomplete) if result.incomplete else "none"),
        "unchanged: " + (", ".join(result.unchanged) if result.unchanged else "none"),
        "conflicts: " + (", ".join(result.conflicts) if result.conflicts else "none"),
        "failed: " + (", ".join(result.failed) if result.failed else "none"),
    ]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build or repair the approved Aly & Pon Phase 1 Notion databases.")
    parser.add_argument("--inspect", action="store_true", help="Read live Notion state and plan the repair without writes.")
    parser.add_argument("--apply", action="store_true", help="Create missing approved containers or repair missing approved relations.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    load_dotenv()
    result = run_build(os.environ, apply=args.apply, inspect=args.inspect)
    for message in result.messages:
        print(message)
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
