import json
import unittest
from copy import deepcopy
from pathlib import Path

from scripts.bootstrap_notion_phase2 import (
    DASHBOARD_PAGES,
    DATABASE_VIEWS,
    STARTER_AREAS,
    TEMPLATE_PAGES,
    TEMPLATE_MARKER,
    run_bootstrap,
)
from tests.test_build_notion_phase1 import full_data_source, prop_payload


VALID_ENV = {
    "NOTION_TOKEN": "secret_phase2_token_should_not_appear",
    "NOTION_PARENT_PAGE_ID": "1234567890abcdef1234567890abcdef",
}
BASE_SCHEMA = json.loads(Path("notion/workspace-schema.json").read_text(encoding="utf-8"))
APPROVED_DATABASES = [database["name"] for database in BASE_SCHEMA["databases"]]


def text(result):
    return "\n".join(result.messages)


def title_property(name):
    return {"Name": {"type": "title", "title": [{"plain_text": name}]}}


class FakePages:
    def __init__(self):
        self.retrieve_calls = 0

    def retrieve(self, page_id):
        self.retrieve_calls += 1
        return {"id": page_id}


class FakeBlocksChildren:
    def __init__(self, client):
        self.client = client
        self.list_calls = 0

    def list(self, **kwargs):
        self.list_calls += 1
        parent_id = kwargs["block_id"]
        children = self.client.child_pages.get(parent_id, {})
        block_children = self.client.block_children.get(parent_id, [])
        database_children = []
        if parent_id == self.client.parent_page_id:
            database_children = [
                {"type": "child_database", "id": container["id"]}
                for container in self.client.containers.values()
            ]
        return {
            "results": database_children
            + [
                {"type": "child_page", "id": page_id, "child_page": {"title": title}}
                for title, page_id in children.items()
            ]
            + block_children,
            "has_more": False,
        }


class FakeBlocks:
    def __init__(self, client):
        self.children = FakeBlocksChildren(client)


class FakeClient:
    parent_page_id = VALID_ENV["NOTION_PARENT_PAGE_ID"]

    def __init__(self, *, complete=True, fail_view_number=None):
        ids = {name: f"source-{name}" for name in APPROVED_DATABASES}
        self.containers = {}
        self.data_sources = {}
        for name in APPROVED_DATABASES:
            data_source = full_data_source(name, BASE_SCHEMA, ids)
            if not complete and name == "Tasks":
                data_source["properties"].pop("Area", None)
            self.containers[name] = {
                "id": f"container-{name}",
                "title": [{"plain_text": name}],
                "data_sources": [{"id": data_source["id"], "name": name}],
            }
            self.data_sources[data_source["id"]] = data_source
        self.child_pages = {self.parent_page_id: {}}
        self.block_children = {}
        self.views = {name: {} for name in APPROVED_DATABASES}
        self.area_pages = {}
        self.request_calls = []
        self.fail_view_number = fail_view_number
        self.view_create_count = 0
        self.pages = FakePages()
        self.blocks = FakeBlocks(self)

    def request(self, path, method, query=None, body=None, auth=None):
        self.request_calls.append({"path": path, "method": method, "query": query, "body": body})
        if method == "GET" and path.startswith("databases/"):
            database_id = path.split("/", 1)[1]
            for container in self.containers.values():
                if container["id"] == database_id:
                    return container
            raise KeyError(database_id)
        if method == "GET" and path.startswith("data_sources/") and path.count("/") == 1:
            return self.data_sources[path.split("/", 1)[1]]
        if method == "POST" and path.endswith("/query"):
            data_source_id = path.split("/")[1]
            if data_source_id == "source-Areas":
                return {
                    "results": [
                        {"properties": {**title_property(name), "Status": {"type": "select", "select": {"name": status}}}}
                        for name, status in self.area_pages.items()
                    ],
                    "has_more": False,
                }
            return {"results": [], "has_more": False}
        if method == "GET" and path == "views":
            database_name = self.name_for_database_id(query["database_id"])
            return {
                "results": [{"id": view["id"], "object": "view"} for view in self.views[database_name].values()],
                "has_more": False,
            }
        if method == "GET" and path.startswith("views/"):
            view_id = path.split("/", 1)[1]
            for views in self.views.values():
                for view in views.values():
                    if view["id"] == view_id:
                        return view
            raise KeyError(view_id)
        if method == "POST" and path == "views":
            self.view_create_count += 1
            if self.fail_view_number == self.view_create_count:
                raise RuntimeError("view create failed")
            database_name = self.name_for_database_id(body["database_id"])
            view = {
                "id": f"view-{database_name}-{body['name']}",
                "name": body["name"],
                "type": body["type"],
                "filter": body.get("filter"),
                "sorts": body.get("sorts", []),
                "visible_properties": body.get("visible_properties", []),
            }
            self.views[database_name][body["name"]] = view
            return view
        if method == "POST" and path == "pages":
            parent = body["parent"]
            title = body["properties"].get("title", body["properties"].get("Name"))["title"][0]["text"]["content"]
            page_id = f"page-{title}"
            if parent["type"] == "page_id":
                self.child_pages.setdefault(parent["page_id"], {})[title] = page_id
                self.child_pages.setdefault(page_id, {})
                self.block_children[page_id] = [
                    {
                        "type": child["type"],
                        child["type"]: child[child["type"]],
                    }
                    for child in body.get("children", [])
                ]
            elif parent["type"] == "data_source_id":
                status = body["properties"].get("Status", {}).get("select", {}).get("name")
                self.area_pages[title] = status
            return {"id": page_id}
        raise AssertionError(f"Unexpected request: {method} {path}")

    def name_for_database_id(self, database_id):
        for name, container in self.containers.items():
            if container["id"] == database_id:
                return name
        raise KeyError(database_id)

    def write_calls(self):
        return [call for call in self.request_calls if call["method"] == "POST" and call["path"] in {"pages", "views"}]


class BootstrapNotionPhase2Test(unittest.TestCase):
    def test_offline_dry_run_performs_no_network_calls(self):
        client = FakeClient()
        result = run_bootstrap(VALID_ENV, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Dry-run mode", text(result))
        self.assertEqual(client.request_calls, [])
        self.assertEqual(client.pages.retrieve_calls, 0)

    def test_inspect_reads_but_does_not_write(self):
        client = FakeClient()
        result = run_bootstrap(VALID_ENV, inspect=True, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertGreater(client.pages.retrieve_calls, 0)
        self.assertGreater(len(client.request_calls), 0)
        self.assertEqual(client.write_calls(), [])
        self.assertIn("Inspect mode: zero writes performed.", text(result))

    def test_inspect_reports_all_phase1_databases_complete(self):
        client = FakeClient()
        result = run_bootstrap(VALID_ENV, inspect=True, client=client)

        self.assertEqual(result.exit_code, 0)
        for name in APPROVED_DATABASES:
            self.assertIn(f"- {name}: complete", text(result))

    def test_inspect_displays_exact_view_details(self):
        client = FakeClient()
        result = run_bootstrap(VALID_ENV, inspect=True, client=client)

        self.assertEqual(result.exit_code, 0)
        output = text(result)
        self.assertIn("Areas.Active Areas: status=missing", output)
        self.assertIn("layout=table", output)
        self.assertIn("filter=None", output)
        self.assertIn("sorts=[]", output)
        self.assertIn("visible_properties=[]", output)
        self.assertIn("endpoint=POST /v1/views", output)
        self.assertNotIn("container-Areas", output)
        self.assertNotIn("source-Areas", output)

    def test_apply_creates_missing_bootstrap_items_only(self):
        client = FakeClient()
        result = run_bootstrap(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.dashboard_pages_created, DASHBOARD_PAGES)
        self.assertEqual(result.template_pages_created, TEMPLATE_PAGES)
        self.assertEqual(result.starter_areas_created, STARTER_AREAS)
        self.assertEqual(len(result.views_created), sum(len(views) for views in DATABASE_VIEWS.values()))
        first_write = client.write_calls()[0]
        self.assertEqual(first_write["path"], "views")

    def test_unsupported_view_layout_fails_safely(self):
        original = DATABASE_VIEWS["Areas"][0]["type"]
        DATABASE_VIEWS["Areas"][0]["type"] = "calendar"
        try:
            client = FakeClient()
            result = run_bootstrap(VALID_ENV, apply=True, client=client)
        finally:
            DATABASE_VIEWS["Areas"][0]["type"] = original

        self.assertEqual(result.exit_code, 1)
        self.assertIn("Unsupported view layout", text(result))
        self.assertEqual(client.write_calls(), [])

    def test_same_title_incompatible_view_is_hard_conflict(self):
        client = FakeClient()
        client.views["Areas"]["Active Areas"] = {
            "id": "view-Areas-Active Areas",
            "name": "Active Areas",
            "type": "board",
            "filter": None,
            "sorts": [],
            "visible_properties": [],
        }
        result = run_bootstrap(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 1)
        self.assertIn("View conflict for Areas.Active Areas", text(result))
        self.assertEqual(client.write_calls(), [])

    def test_retrieved_sorts_null_matches_approved_empty_sorts(self):
        client = FakeClient()
        client.views["Areas"]["Active Areas"] = {
            "id": "view-Areas-Active Areas",
            "name": "Active Areas",
            "type": "table",
            "filter": None,
            "sorts": None,
            "visible_properties": [],
        }
        result = run_bootstrap(VALID_ENV, inspect=True, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Areas.Active Areas: status=matching", text(result))

    def test_omitted_sorts_matches_approved_empty_sorts(self):
        client = FakeClient()
        client.views["Areas"]["Active Areas"] = {
            "id": "view-Areas-Active Areas",
            "name": "Active Areas",
            "type": "table",
            "filter": None,
            "visible_properties": [],
        }
        result = run_bootstrap(VALID_ENV, inspect=True, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Areas.Active Areas: status=matching", text(result))

    def test_retrieved_empty_sorts_matches_approved_empty_sorts(self):
        client = FakeClient()
        client.views["Areas"]["Active Areas"] = {
            "id": "view-Areas-Active Areas",
            "name": "Active Areas",
            "type": "table",
            "filter": None,
            "sorts": [],
            "visible_properties": [],
        }
        result = run_bootstrap(VALID_ENV, inspect=True, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Areas.Active Areas: status=matching", text(result))

    def test_non_empty_retrieved_sorts_conflicts_with_no_sorts(self):
        client = FakeClient()
        client.views["Areas"]["Active Areas"] = {
            "id": "view-Areas-Active Areas",
            "name": "Active Areas",
            "type": "table",
            "filter": None,
            "sorts": [{"property": "Name", "direction": "ascending"}],
            "visible_properties": [],
        }
        result = run_bootstrap(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 1)
        self.assertIn("View conflict for Areas.Active Areas", text(result))
        self.assertEqual(client.write_calls(), [])

    def test_retrieved_filter_null_matches_omitted_approved_filter(self):
        client = FakeClient()
        client.views["Tasks"]["Open Tasks"] = {
            "id": "view-Tasks-Open Tasks",
            "name": "Open Tasks",
            "type": "table",
            "filter": None,
            "sorts": None,
        }
        result = run_bootstrap(VALID_ENV, inspect=True, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Tasks.Open Tasks: status=matching", text(result))

    def test_omitted_visible_properties_matches_empty_list(self):
        client = FakeClient()
        client.views["Decisions"]["Decision Log"] = {
            "id": "view-Decisions-Decision Log",
            "name": "Decision Log",
            "type": "table",
            "filter": None,
            "sorts": None,
        }
        result = run_bootstrap(VALID_ENV, inspect=True, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Decisions.Decision Log: status=matching", text(result))

    def test_non_empty_visible_properties_remain_conflict(self):
        client = FakeClient()
        client.views["Meetings"]["Meeting Log"] = {
            "id": "view-Meetings-Meeting Log",
            "name": "Meeting Log",
            "type": "table",
            "filter": None,
            "sorts": None,
            "visible_properties": ["Name"],
        }
        result = run_bootstrap(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 1)
        self.assertIn("View conflict for Meetings.Meeting Log", text(result))
        self.assertEqual(client.write_calls(), [])

    def test_all_five_live_style_views_classify_as_matching(self):
        client = FakeClient()
        for database, views in DATABASE_VIEWS.items():
            view = views[0]
            client.views[database][view["name"]] = {
                "id": f"view-{database}-{view['name']}",
                "name": view["name"],
                "type": "table",
                "filter": None,
                "sorts": None,
            }
        result = run_bootstrap(VALID_ENV, inspect=True, client=client)

        self.assertEqual(result.exit_code, 0)
        for database, views in DATABASE_VIEWS.items():
            self.assertIn(f"{database}.{views[0]['name']}: status=matching", text(result))

    def test_all_conflicts_are_detected_before_writes(self):
        client = FakeClient()
        client.views["Areas"]["Active Areas"] = {"id": "view-a", "name": "Active Areas", "type": "board"}
        client.area_pages["Brand"] = "Paused"
        result = run_bootstrap(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 1)
        self.assertIn("View conflict for Areas.Active Areas", text(result))
        self.assertIn("Starter Area conflict for Brand", text(result))
        self.assertEqual(client.write_calls(), [])

    def test_failed_first_view_operation_creates_no_other_content(self):
        client = FakeClient(fail_view_number=1)
        result = run_bootstrap(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.dashboard_pages_created, [])
        self.assertEqual(result.template_pages_created, [])
        self.assertEqual(result.starter_areas_created, [])
        self.assertEqual(result.views_created, [])

    def test_partial_view_success_is_reported_accurately(self):
        client = FakeClient(fail_view_number=2)
        result = run_bootstrap(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.views_created, ["Areas.Active Areas"])
        self.assertEqual(result.dashboard_pages_created, [])

    def test_second_apply_creates_nothing_new(self):
        client = FakeClient()
        first = run_bootstrap(VALID_ENV, apply=True, client=client)
        write_count = len(client.write_calls())
        second = run_bootstrap(VALID_ENV, apply=True, client=client)
        second_writes = client.write_calls()[write_count:]

        self.assertEqual(first.exit_code, 0)
        self.assertEqual(second.exit_code, 0)
        self.assertEqual(second_writes, [])
        self.assertIn("Phase 2 bootstrap", second.unchanged)

    def test_does_not_create_disallowed_records(self):
        client = FakeClient()
        run_bootstrap(VALID_ENV, apply=True, client=client)

        data_source_page_writes = [
            call for call in client.write_calls()
            if call["path"] == "pages" and call["body"]["parent"]["type"] == "data_source_id"
        ]
        self.assertTrue(data_source_page_writes)
        self.assertTrue(all(call["body"]["parent"]["data_source_id"] == "source-Areas" for call in data_source_page_writes))

    def test_existing_user_content_is_not_modified(self):
        client = FakeClient()
        client.area_pages["Brand"] = "Active"
        client.child_pages[client.parent_page_id]["Aly & Pon OS Home"] = "user-page-home"

        result = run_bootstrap(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertNotIn("Brand", result.starter_areas_created)
        self.assertNotIn("Aly & Pon OS Home", result.dashboard_pages_created)
        self.assertEqual(client.area_pages["Brand"], "Active")
        self.assertEqual(client.child_pages[client.parent_page_id]["Aly & Pon OS Home"], "user-page-home")

    def test_incomplete_phase1_stops_before_writes(self):
        client = FakeClient(complete=False)
        result = run_bootstrap(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 1)
        self.assertEqual(client.write_calls(), [])
        self.assertIn("Phase 1 databases are incomplete", text(result))

    def test_matching_items_are_skipped(self):
        client = FakeClient()
        run_bootstrap(VALID_ENV, apply=True, client=client)
        second = run_bootstrap(VALID_ENV, inspect=True, client=client)

        self.assertEqual(second.exit_code, 0)
        self.assertIn("dashboard pages matching: Aly & Pon OS Home", text(second))
        self.assertIn("starter Areas matching: Brand", text(second))

    def test_token_remains_redacted(self):
        result = run_bootstrap(VALID_ENV)

        self.assertIn("<redacted>", text(result))
        self.assertNotIn(VALID_ENV["NOTION_TOKEN"], text(result))

    def test_no_products_recipes_vendors_inventory_records_are_planned(self):
        result = run_bootstrap(VALID_ENV)

        self.assertIn("starter Areas", text(result))
        self.assertNotIn("Recipes", text(result))
        self.assertNotIn("Inventory", text(result))
        self.assertNotIn("Vendors", text(result))


if __name__ == "__main__":
    unittest.main()
