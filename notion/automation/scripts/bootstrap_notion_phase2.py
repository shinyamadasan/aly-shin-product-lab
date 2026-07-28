"""Bootstrap Phase 2 workspace defaults for Aly & Pon OS."""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

from dotenv import load_dotenv

try:
    from build_notion_phase1 import (
        APPROVED_DATABASES,
        SCHEMA_PATH,
        api_error_message,
        load_notion_client,
        load_workspace_schema,
        short_id,
        validate_env,
        inspect_workspace as inspect_phase1_workspace,
    )
except ModuleNotFoundError:
    from automation.scripts.build_notion_phase1 import (
        APPROVED_DATABASES,
        SCHEMA_PATH,
        api_error_message,
        load_notion_client,
        load_workspace_schema,
        short_id,
        validate_env,
        inspect_workspace as inspect_phase1_workspace,
    )


STARTER_AREAS = [
    "Brand",
    "Marketing",
    "Operations",
    "Products",
    "Finance",
    "Customer Experience",
    "Technology",
    "Suppliers",
]
DASHBOARD_PAGES = [
    "Aly & Pon OS Home",
    "Aly & Pon Operating Dashboard",
    "Aly & Pon Template Library",
]
TEMPLATE_PAGES = [
    "Area Template",
    "Task Template",
    "Decision Template",
    "Meeting Template",
    "Approval Template",
]
DATABASE_VIEWS = {
    "Areas": [{"name": "Active Areas", "type": "table", "filter": None, "sorts": [], "visible_properties": []}],
    "Tasks": [{"name": "Open Tasks", "type": "table", "filter": None, "sorts": [], "visible_properties": []}],
    "Decisions": [{"name": "Decision Log", "type": "table", "filter": None, "sorts": [], "visible_properties": []}],
    "Meetings": [{"name": "Meeting Log", "type": "table", "filter": None, "sorts": [], "visible_properties": []}],
    "Approvals": [{"name": "Approval Queue", "type": "table", "filter": None, "sorts": [], "visible_properties": []}],
}
SUPPORTED_VIEW_TYPES = {"table"}
TEMPLATE_MARKER = "Aly & Pon structural template reference."


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
class BootstrapPlan:
    missing_dashboards: list[str] = field(default_factory=list)
    matching_dashboards: list[str] = field(default_factory=list)
    missing_template_pages: list[str] = field(default_factory=list)
    matching_template_pages: list[str] = field(default_factory=list)
    missing_views: dict[str, list[str]] = field(default_factory=dict)
    matching_views: dict[str, list[str]] = field(default_factory=dict)
    missing_starter_areas: list[str] = field(default_factory=list)
    matching_starter_areas: list[str] = field(default_factory=list)
    phase1_status: dict[str, str] = field(default_factory=dict)
    phase1_state: dict[str, Any] = field(default_factory=dict)
    conflicts: list[str] = field(default_factory=list)
    existing_template_library_id: str | None = None


@dataclass
class BootstrapResult:
    exit_code: int = 0
    messages: list[str] = field(default_factory=list)
    dashboard_pages_created: list[str] = field(default_factory=list)
    template_pages_created: list[str] = field(default_factory=list)
    views_created: list[str] = field(default_factory=list)
    starter_areas_created: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)


def rich_text(content: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": {"content": content}}]


def title_from_page(page: dict[str, Any]) -> str:
    props = page.get("properties", {})
    for prop in props.values():
        if prop.get("type") == "title":
            return "".join(item.get("plain_text", "") for item in prop.get("title", []))
    return ""


def list_child_pages(client: NotionClient, parent_page_id: str) -> dict[str, str]:
    pages: dict[str, str] = {}
    cursor: str | None = None
    while True:
        query = {"block_id": parent_page_id, "page_size": 100}
        if cursor:
            query["start_cursor"] = cursor
        response = client.blocks.children.list(**query)
        for child in response.get("results", []):
            if child.get("type") != "child_page":
                continue
            title = child.get("child_page", {}).get("title", "")
            page_id = child.get("id")
            if title and page_id:
                pages[title] = page_id
        if not response.get("has_more"):
            return pages
        cursor = response.get("next_cursor")


def list_child_page_titles(client: NotionClient, parent_page_id: str) -> set[str]:
    return set(list_child_pages(client, parent_page_id))


def block_plain_text(block: dict[str, Any]) -> str:
    block_type = block.get("type")
    rich_text = block.get(block_type, {}).get("rich_text", []) if block_type else []
    return "".join(item.get("plain_text") or item.get("text", {}).get("content", "") for item in rich_text)


def page_contains_marker(client: NotionClient, page_id: str, marker: str) -> bool:
    cursor: str | None = None
    while True:
        query = {"block_id": page_id, "page_size": 100}
        if cursor:
            query["start_cursor"] = cursor
        response = client.blocks.children.list(**query)
        for child in response.get("results", []):
            if marker in block_plain_text(child):
                return True
        if not response.get("has_more"):
            return False
        cursor = response.get("next_cursor")


def list_views(client: NotionClient, database_id: str) -> dict[str, dict[str, Any]]:
    views: dict[str, dict[str, Any]] = {}
    cursor: str | None = None
    while True:
        query: dict[str, Any] = {"database_id": database_id, "page_size": 100}
        if cursor:
            query["start_cursor"] = cursor
        response = client.request("views", "GET", query=query)
        for reference in response.get("results", []):
            view_id = reference.get("id")
            if not view_id:
                continue
            view = client.request(f"views/{view_id}", "GET")
            name = view.get("name")
            if name:
                views[name] = view
        if not response.get("has_more"):
            return views
        cursor = response.get("next_cursor")


def query_data_source_titles(client: NotionClient, data_source_id: str) -> set[str]:
    titles: set[str] = set()
    cursor: str | None = None
    while True:
        body: dict[str, Any] = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        response = client.request(f"data_sources/{data_source_id}/query", "POST", body=body)
        for page in response.get("results", []):
            title = title_from_page(page)
            if title:
                titles.add(title)
        if not response.get("has_more"):
            return titles
        cursor = response.get("next_cursor")


def query_data_source_pages_by_title(client: NotionClient, data_source_id: str) -> dict[str, dict[str, Any]]:
    pages: dict[str, dict[str, Any]] = {}
    cursor: str | None = None
    while True:
        body: dict[str, Any] = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        response = client.request(f"data_sources/{data_source_id}/query", "POST", body=body)
        for page in response.get("results", []):
            title = title_from_page(page)
            if title:
                pages[title] = page
        if not response.get("has_more"):
            return pages
        cursor = response.get("next_cursor")


def create_child_page(client: NotionClient, parent_page_id: str, title: str, children: list[dict[str, Any]]) -> dict[str, Any]:
    return client.request(
        "pages",
        "POST",
        body={
            "parent": {"type": "page_id", "page_id": parent_page_id},
            "properties": {"title": {"title": rich_text(title)}},
            "children": children,
        },
    )


def create_area_page(client: NotionClient, data_source_id: str, name: str) -> dict[str, Any]:
    return client.request(
        "pages",
        "POST",
        body={
            "parent": {"type": "data_source_id", "data_source_id": data_source_id},
            "properties": {
                "Name": {"title": rich_text(name)},
                "Status": {"select": {"name": "Active"}},
            },
            "children": placeholder_blocks(["Description", "Operating Notes", "Review Notes"]),
        },
    )


def create_view(client: NotionClient, database_id: str, data_source_id: str, view: dict[str, str]) -> dict[str, Any]:
    body: dict[str, Any] = {
        "database_id": database_id,
        "data_source_id": data_source_id,
        "name": view["name"],
        "type": view["type"],
    }
    if view["filter"] is not None:
        body["filter"] = view["filter"]
    if view["sorts"]:
        body["sorts"] = view["sorts"]
    if view["visible_properties"]:
        body["visible_properties"] = view["visible_properties"]
    return client.request(
        "views",
        "POST",
        body=body,
    )


def paragraph(text: str) -> dict[str, Any]:
    return {"object": "block", "type": "paragraph", "paragraph": {"rich_text": rich_text(text)}}


def heading(text: str) -> dict[str, Any]:
    return {"object": "block", "type": "heading_2", "heading_2": {"rich_text": rich_text(text)}}


def placeholder_blocks(sections: list[str]) -> list[dict[str, Any]]:
    blocks = [
        paragraph("Structural placeholder. Replace with approved business content."),
        paragraph(TEMPLATE_MARKER),
    ]
    for section in sections:
        blocks.append(heading(section))
        blocks.append(paragraph("TBD"))
    return blocks


def dashboard_blocks(title: str) -> list[dict[str, Any]]:
    return placeholder_blocks(["Purpose", "Linked Databases", "Operating Rhythm"])


def template_blocks(template_name: str) -> list[dict[str, Any]]:
    return placeholder_blocks(["Purpose", "Required Fields", "Notes"])


def validate_phase1_complete(plan: Any) -> list[str]:
    errors: list[str] = []
    missing = [name for name in APPROVED_DATABASES if name not in plan.existing]
    if missing:
        errors.append("Missing Phase 1 databases: " + ", ".join(missing))
    if plan.conflicts:
        errors.append("Phase 1 schema conflicts must be resolved before Phase 2 bootstrap.")
    if plan.incomplete:
        errors.append("Phase 1 databases are incomplete: " + ", ".join(plan.incomplete))
    return errors


def validate_view_configs() -> list[str]:
    errors: list[str] = []
    allowed_keys = {"name", "type", "filter", "sorts", "visible_properties"}
    approved = {
        "Areas": {"Active Areas"},
        "Tasks": {"Open Tasks"},
        "Decisions": {"Decision Log"},
        "Meetings": {"Meeting Log"},
        "Approvals": {"Approval Queue"},
    }
    for database, views in DATABASE_VIEWS.items():
        names = {view.get("name") for view in views}
        if names != approved[database]:
            errors.append(f"Unsupported view set for {database}: {sorted(names)}")
        for view in views:
            extra = set(view) - allowed_keys
            if extra:
                errors.append(f"Unsupported view configuration keys for {database}.{view.get('name')}: {sorted(extra)}")
            if view.get("type") not in SUPPORTED_VIEW_TYPES:
                errors.append(f"Unsupported view layout for {database}.{view.get('name')}: {view.get('type')}")
            if not isinstance(view.get("sorts"), list):
                errors.append(f"Unsupported sorts configuration for {database}.{view.get('name')}")
            if not isinstance(view.get("visible_properties"), list):
                errors.append(f"Unsupported visible property configuration for {database}.{view.get('name')}")
    return errors


def normalized_view_config(view: dict[str, Any]) -> dict[str, Any]:
    def optional_dict(value: Any) -> dict[str, Any] | None:
        return value if value else None

    def optional_list(value: Any) -> list[Any]:
        return value if value else []

    return {
        "type": view.get("type"),
        "filter": optional_dict(view.get("filter")),
        "sorts": optional_list(view.get("sorts")),
        "visible_properties": optional_list(
            view.get("visible_properties", view.get("display_properties"))
        ),
    }


def expected_view_config(view: dict[str, Any]) -> dict[str, Any]:
    return normalized_view_config(view)


def area_status(page: dict[str, Any]) -> str | None:
    status = page.get("properties", {}).get("Status", {})
    if status.get("type") != "select":
        return None
    selected = status.get("select")
    if not selected:
        return None
    return selected.get("name")


def build_bootstrap_plan(client: NotionClient, parent_page_id: str, phase1_plan: Any) -> BootstrapPlan:
    plan = BootstrapPlan()
    plan.phase1_status = {name: "complete" for name in APPROVED_DATABASES if name in phase1_plan.complete}
    plan.phase1_state = phase1_plan.existing
    config_errors = validate_view_configs()
    if config_errors:
        plan.conflicts.extend(config_errors)

    child_pages = list_child_pages(client, parent_page_id)
    for title in DASHBOARD_PAGES:
        if title not in child_pages:
            plan.missing_dashboards.append(title)
        else:
            plan.matching_dashboards.append(title)
    plan.existing_template_library_id = child_pages.get("Aly & Pon Template Library")

    if plan.existing_template_library_id:
        template_pages = list_child_pages(client, plan.existing_template_library_id)
        for title in DASHBOARD_PAGES:
            if title != "Aly & Pon Template Library" and title in template_pages:
                plan.conflicts.append(f"Dashboard page has same title in wrong location: {title}")
        for title in TEMPLATE_PAGES:
            if title not in template_pages:
                plan.missing_template_pages.append(title)
            elif page_contains_marker(client, template_pages[title], TEMPLATE_MARKER):
                plan.matching_template_pages.append(title)
            else:
                plan.conflicts.append(f"Template reference page conflict for {title}: missing structural marker")
    else:
        plan.missing_template_pages.extend(TEMPLATE_PAGES)
    wrong_location = [title for title in TEMPLATE_PAGES if title in child_pages]
    for title in wrong_location:
        plan.conflicts.append(f"Template reference page has same title in wrong location: {title}")

    for database_name, desired_views in DATABASE_VIEWS.items():
        state = phase1_plan.existing[database_name]
        existing_views = list_views(client, state.database_id)
        missing: list[str] = []
        matching: list[str] = []
        for view in desired_views:
            if view["name"] not in existing_views:
                missing.append(view["name"])
                continue
            live_config = normalized_view_config(existing_views[view["name"]])
            expected_config = expected_view_config(view)
            if live_config == expected_config:
                matching.append(view["name"])
            else:
                plan.conflicts.append(
                    f"View conflict for {database_name}.{view['name']}: expected {expected_config}, found {live_config}"
                )
        if missing:
            plan.missing_views[database_name] = missing
        if matching:
            plan.matching_views[database_name] = matching

    area_pages = query_data_source_pages_by_title(client, phase1_plan.existing["Areas"].data_source_id)
    for name in STARTER_AREAS:
        if name not in area_pages:
            plan.missing_starter_areas.append(name)
            continue
        if area_status(area_pages[name]) == "Active":
            plan.matching_starter_areas.append(name)
        else:
            plan.conflicts.append(f"Starter Area conflict for {name}: expected Status=Active")
    return plan


def append_plan_messages(result: BootstrapResult, plan: BootstrapPlan, *, inspect: bool) -> None:
    result.messages.append("Phase 1 databases:")
    for name in APPROVED_DATABASES:
        result.messages.append(f"- {name}: {plan.phase1_status.get(name, 'not complete')}")
    result.messages.append("dashboard pages missing: " + (", ".join(plan.missing_dashboards) if plan.missing_dashboards else "none"))
    result.messages.append("dashboard pages matching: " + (", ".join(plan.matching_dashboards) if plan.matching_dashboards else "none"))
    result.messages.append("template pages missing: " + (", ".join(plan.missing_template_pages) if plan.missing_template_pages else "none"))
    result.messages.append("template pages matching: " + (", ".join(plan.matching_template_pages) if plan.matching_template_pages else "none"))
    result.messages.append("starter Areas missing: " + (", ".join(plan.missing_starter_areas) if plan.missing_starter_areas else "none"))
    result.messages.append("starter Areas matching: " + (", ".join(plan.matching_starter_areas) if plan.matching_starter_areas else "none"))
    result.messages.append("Approved view plan:")
    for database, desired_views in DATABASE_VIEWS.items():
        for view in desired_views:
            state = plan.phase1_state[database] if hasattr(plan, "phase1_state") else None
            database_id = short_id(state.database_id) if state else "<inspect-required>"
            data_source_id = short_id(state.data_source_id) if state else "<inspect-required>"
            expected = expected_view_config(view)
            status = "missing" if view["name"] in plan.missing_views.get(database, []) else "matching"
            if any(conflict.startswith(f"View conflict for {database}.{view['name']}") for conflict in plan.conflicts):
                status = "conflict"
            result.messages.append(
                f"- {database}.{view['name']}: status={status}; database_id={database_id}; "
                f"data_source_id={data_source_id}; layout={expected['type']}; filter={expected['filter']}; "
                f"sorts={expected['sorts']}; visible_properties={expected['visible_properties']}; endpoint=POST /v1/views"
            )
    for database, views in plan.missing_views.items():
        result.messages.append(f"{database} views missing: " + ", ".join(views))
    if not plan.missing_views:
        result.messages.append("database views missing: none")
    if plan.conflicts:
        result.messages.append("conflicts:")
        result.messages.extend(plan.conflicts)
    result.messages.extend([
        "new Tasks planned: 0",
        "new Decisions planned: 0",
        "new Meetings planned: 0",
        "new Approvals planned: 0",
        "product records planned: 0",
        "recipe records planned: 0",
        "vendor records planned: 0",
        "inventory records planned: 0",
        "marketing-content records planned: 0",
        "user-created content modifications planned: 0",
    ])
    if inspect:
        result.messages.append("Inspect mode: zero writes performed.")
        result.messages.append("writes performed: 0")


def apply_bootstrap_plan(
    client: NotionClient,
    parent_page_id: str,
    phase1_plan: Any,
    plan: BootstrapPlan,
    result: BootstrapResult,
) -> BootstrapResult:
    if plan.conflicts:
        result.exit_code = 1
        result.conflicts = plan.conflicts
        result.messages.append("Stopped before writes because conflicts were found.")
        result.messages.extend(summary_messages(result))
        return result

    template_library_id = plan.existing_template_library_id
    for database_name, missing_views in plan.missing_views.items():
        state = phase1_plan.existing[database_name]
        desired_by_name = {view["name"]: view for view in DATABASE_VIEWS[database_name]}
        for view_name in missing_views:
            create_view(client, state.database_id, state.data_source_id, desired_by_name[view_name])
            result.views_created.append(f"{database_name}.{view_name}")

    for title in plan.missing_dashboards:
        created = create_child_page(client, parent_page_id, title, dashboard_blocks(title))
        result.dashboard_pages_created.append(title)
        if title == "Aly & Pon Template Library":
            template_library_id = created["id"]

    if not template_library_id and plan.missing_template_pages:
        result.exit_code = 1
        result.failed.append("Aly & Pon Template Library")
        result.messages.append("Could not create template pages because the Template Library page ID is unavailable.")
        result.messages.extend(summary_messages(result))
        return result

    for title in plan.missing_template_pages:
        create_child_page(client, template_library_id, title, template_blocks(title))
        result.template_pages_created.append(title)

    areas_data_source_id = phase1_plan.existing["Areas"].data_source_id
    for area_name in plan.missing_starter_areas:
        create_area_page(client, areas_data_source_id, area_name)
        result.starter_areas_created.append(area_name)

    if not any([result.dashboard_pages_created, result.template_pages_created, result.views_created, result.starter_areas_created]):
        result.unchanged.append("Phase 2 bootstrap")
    result.messages.extend(summary_messages(result))
    return result


def summary_messages(result: BootstrapResult) -> list[str]:
    return [
        "Final summary:",
        "dashboard pages created: " + (", ".join(result.dashboard_pages_created) if result.dashboard_pages_created else "none"),
        "template pages created: " + (", ".join(result.template_pages_created) if result.template_pages_created else "none"),
        "views created: " + (", ".join(result.views_created) if result.views_created else "none"),
        "starter Areas created: " + (", ".join(result.starter_areas_created) if result.starter_areas_created else "none"),
        "unchanged: " + (", ".join(result.unchanged) if result.unchanged else "none"),
        "conflicts: " + (", ".join(result.conflicts) if result.conflicts else "none"),
        "failed: " + (", ".join(result.failed) if result.failed else "none"),
    ]


def run_bootstrap(
    env: Mapping[str, str],
    *,
    inspect: bool = False,
    apply: bool = False,
    client: NotionClient | None = None,
) -> BootstrapResult:
    if inspect and apply:
        return BootstrapResult(exit_code=1, messages=["Use only one mode: --inspect or --apply."])

    result = BootstrapResult()
    values, env_errors = validate_env(env)
    schema, schema_errors = load_workspace_schema(SCHEMA_PATH)
    if env_errors or schema_errors or schema is None:
        result.exit_code = 1
        result.messages.extend(env_errors)
        result.messages.extend(schema_errors)
        return result

    token = values["NOTION_TOKEN"]
    parent_page_id = values["NOTION_PARENT_PAGE_ID"]
    result.messages.append("Required environment variables are present.")
    result.messages.append("NOTION_PARENT_PAGE_ID format is valid.")
    result.messages.append("NOTION_TOKEN: <redacted>")
    result.messages.append("Phase 2 bootstrap plan:")
    result.messages.append("dashboard pages: " + ", ".join(DASHBOARD_PAGES))
    result.messages.append("database views: " + ", ".join(f"{db}.{view['name']}" for db, views in DATABASE_VIEWS.items() for view in views))
    result.messages.append("template reference pages: " + ", ".join(TEMPLATE_PAGES))
    result.messages.append("starter Areas: " + ", ".join(STARTER_AREAS))

    if not inspect and not apply:
        result.messages.append("Dry-run mode: no live Notion reads or writes will be performed.")
        result.messages.append("Inspect mode would read live Phase 1 state and report missing bootstrap items.")
        result.messages.append("Apply mode would create only missing dashboard pages, views, template reference pages, and starter Areas.")
        return result

    notion = client if client is not None else load_notion_client(token)
    try:
        notion.pages.retrieve(page_id=parent_page_id)
        result.messages.append("Configured parent page is accessible.")
        phase1_plan = inspect_phase1_workspace(notion, parent_page_id, schema)
        phase1_errors = validate_phase1_complete(phase1_plan)
        if phase1_errors:
            result.exit_code = 1
            result.conflicts.extend(phase1_errors)
            result.messages.extend(phase1_errors)
            return result
        plan = build_bootstrap_plan(notion, parent_page_id, phase1_plan)
        append_plan_messages(result, plan, inspect=inspect)
        if inspect:
            return result
        return apply_bootstrap_plan(notion, parent_page_id, phase1_plan, plan, result)
    except Exception as exc:
        result.exit_code = 1
        result.failed.append("Notion API")
        result.messages.append(api_error_message(exc, "Phase 2 workspace bootstrap"))
        result.messages.extend(summary_messages(result))
        return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bootstrap Aly & Pon Phase 2 Notion workspace defaults.")
    parser.add_argument("--inspect", action="store_true", help="Read live Notion state and plan bootstrap without writes.")
    parser.add_argument("--apply", action="store_true", help="Create missing approved Phase 2 bootstrap items.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    load_dotenv()
    result = run_bootstrap(os.environ, inspect=args.inspect, apply=args.apply)
    for message in result.messages:
        print(message)
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
