import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from automation.scripts.build_notion_phase1 import APPROVED_DATABASES, NOTION_API_VERSION, load_notion_client, run_build


VALID_ENV = {
    "NOTION_TOKEN": "secret_build_token_should_not_appear",
    "NOTION_PARENT_PAGE_ID": "1234567890abcdef1234567890abcdef",
}

ROOT = Path(__file__).resolve().parents[2]
BASE_SCHEMA = json.loads((ROOT / "schema" / "workspace-schema.json").read_text(encoding="utf-8"))


def write_schema(schema):
    handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    with handle:
        json.dump(schema, handle)
    return Path(handle.name)


def text(result):
    return "\n".join(result.messages)


def prop_payload(prop, schema, data_source_ids):
    prop_type = prop["type"]
    if prop_type == "select":
        options = prop.get("options") or schema["statusSystems"][prop["optionsRef"]]
        return {"type": "select", "select": {"options": [{"name": option} for option in options]}}
    if prop_type == "relation":
        return {
            "type": "relation",
            "relation": {
                "database_id": f"container-{prop['relatedDatabase']}",
                "data_source_id": data_source_ids[prop["relatedDatabase"]],
                "type": "single_property",
                "single_property": {},
            },
        }
    return {"type": prop_type, prop_type: {}}


def full_data_source(name, schema, data_source_ids):
    database = next(item for item in schema["databases"] if item["name"] == name)
    return {
        "id": data_source_ids[name],
        "object": "data_source",
        "properties": {prop["name"]: prop_payload(prop, schema, data_source_ids) for prop in database["properties"]},
    }


def partial_data_source(name, schema, data_source_ids):
    database = next(item for item in schema["databases"] if item["name"] == name)
    return {
        "id": data_source_ids[name],
        "object": "data_source",
        "properties": {
            prop["name"]: prop_payload(prop, schema, data_source_ids)
            for prop in database["properties"]
            if prop["type"] != "relation"
        },
    }


class ApiFailure(Exception):
    status = 400
    code = "validation_error"
    message = "Bad request containing secret_build_token_should_not_appear"


class FakePages:
    def __init__(self):
        self.retrieve_calls = 0

    def retrieve(self, page_id):
        self.retrieve_calls += 1
        return {"id": page_id}


class FakeBlocksChildren:
    def __init__(self, containers):
        self.containers = containers
        self.list_calls = 0

    def list(self, **kwargs):
        self.list_calls += 1
        return {
            "results": [{"type": "child_database", "id": container["id"]} for container in self.containers.values()],
            "has_more": False,
        }


class FakeBlocks:
    def __init__(self, containers):
        self.children = FakeBlocksChildren(containers)


class FakeClient:
    def __init__(self, existing=None, fail_update=False, fail_on_patch_number=None):
        self.containers = {}
        self.data_sources = {}
        self.request_calls = []
        self.fail_update = fail_update
        self.fail_on_patch_number = fail_on_patch_number
        self.patch_count = 0
        for name, data_source in (existing or {}).items():
            self.containers[name] = {
                "id": f"container-{name}",
                "title": [{"plain_text": name}],
                "data_sources": [{"id": data_source["id"], "name": name}],
            }
            self.data_sources[data_source["id"]] = data_source
        self.pages = FakePages()
        self.blocks = FakeBlocks(self.containers)

    def request(self, path, method, query=None, body=None, auth=None):
        self.request_calls.append({"path": path, "method": method, "body": body})
        if method == "GET" and path.startswith("databases/"):
            database_id = path.split("/", 1)[1]
            for container in self.containers.values():
                if container["id"] == database_id:
                    return container
            raise KeyError(database_id)
        if method == "GET" and path.startswith("data_sources/"):
            return self.data_sources[path.split("/", 1)[1]]
        if method == "POST" and path == "databases":
            name = body["title"][0]["text"]["content"]
            container_id = f"container-{name}"
            data_source_id = f"source-{name}"
            container = {
                "id": container_id,
                "title": [{"plain_text": name}],
                "data_sources": [{"id": data_source_id, "name": name}],
            }
            data_source = {
                "id": data_source_id,
                "object": "data_source",
                "properties": {
                    prop_name: {"type": next(iter(payload)), next(iter(payload)): payload[next(iter(payload))]}
                    for prop_name, payload in body["initial_data_source"]["properties"].items()
                },
            }
            self.containers[name] = container
            self.data_sources[data_source_id] = data_source
            return container
        if method == "PATCH" and path.startswith("data_sources/"):
            self.patch_count += 1
            if self.fail_update or self.fail_on_patch_number == self.patch_count:
                raise ApiFailure()
            data_source_id = path.split("/", 1)[1]
            for prop_name, payload in body["properties"].items():
                prop_type = payload.get("type") or next(iter(payload))
                stored_payload = deepcopy(payload[prop_type])
                if prop_type == "relation" and "type" not in stored_payload:
                    stored_payload["type"] = "single_property" if "single_property" in stored_payload else "dual_property"
                self.data_sources[data_source_id]["properties"][prop_name] = {
                    "type": prop_type,
                    prop_type: stored_payload,
                }
            return self.data_sources[data_source_id]
        raise AssertionError(f"Unexpected request: {method} {path}")

    def write_calls(self):
        return [call for call in self.request_calls if call["method"] in {"POST", "PATCH"}]


class BuildNotionPhase1Test(unittest.TestCase):
    def tearDown(self):
        for path in getattr(self, "paths", []):
            path.unlink(missing_ok=True)

    def schema_path(self, schema):
        path = write_schema(schema)
        self.paths = getattr(self, "paths", []) + [path]
        return path

    def ids(self):
        return {name: f"source-{name}" for name in APPROVED_DATABASES}

    def existing(self, *, full=True):
        ids = self.ids()
        factory = full_data_source if full else partial_data_source
        return {name: factory(name, BASE_SCHEMA, ids) for name in APPROVED_DATABASES}

    def test_client_uses_current_notion_api_version(self):
        client = load_notion_client("x")
        self.assertEqual(client.options.notion_version, NOTION_API_VERSION)

    def test_dry_run_performs_no_network_calls(self):
        client = FakeClient()
        result = run_build(VALID_ENV, apply=False, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 0)
        self.assertIn("no live Notion reads or writes", text(result))
        self.assertEqual(client.request_calls, [])
        self.assertEqual(client.pages.retrieve_calls, 0)

    def test_inspect_performs_reads_but_no_writes(self):
        client = FakeClient(self.existing(full=False))
        result = run_build(VALID_ENV, inspect=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 0)
        self.assertGreater(client.pages.retrieve_calls, 0)
        self.assertGreater(len(client.request_calls), 0)
        self.assertEqual(client.write_calls(), [])
        self.assertIn("Inspect mode: zero writes performed.", text(result))

    def test_valid_schema_loads_successfully(self):
        result = run_build(VALID_ENV, apply=False, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 0)
        self.assertIn("workspace-schema.json is valid for Phase 1.", text(result))

    def test_only_five_approved_databases_are_accepted(self):
        result = run_build(VALID_ENV, apply=False, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 0)
        self.assertIn("Creation order: " + ", ".join(APPROVED_DATABASES), text(result))

    def test_unexpected_active_database_is_rejected(self):
        schema = deepcopy(BASE_SCHEMA)
        schema["databases"].append({"name": "Vendors", "properties": [{"name": "Name", "type": "title"}]})
        result = run_build(VALID_ENV, apply=False, schema_path=self.schema_path(schema))
        self.assertEqual(result.exit_code, 1)
        self.assertIn("Unexpected active database is not approved", text(result))

    def test_database_container_response_resolves_primary_data_source_id(self):
        client = FakeClient(self.existing(full=True))
        result = run_build(VALID_ENV, inspect=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 0)
        self.assertIn("data_source_id=sour...reas", text(result))

    def test_schema_retrieval_uses_data_source_endpoint(self):
        client = FakeClient(self.existing(full=True))
        run_build(VALID_ENV, inspect=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertTrue(any(call["path"].startswith("data_sources/") and call["method"] == "GET" for call in client.request_calls))

    def test_relation_payload_uses_related_data_source_id(self):
        client = FakeClient(self.existing(full=False))
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 0)
        patch_calls = [call for call in client.request_calls if call["method"] == "PATCH"]
        self.assertTrue(any(call["body"]["properties"] for call in patch_calls))
        payload_text = json.dumps([call["body"] for call in patch_calls])
        self.assertIn("data_source_id", payload_text)
        self.assertNotIn('"database_id"', payload_text)

    def test_relation_create_payload_contains_one_way_relation_shape(self):
        client = FakeClient(self.existing(full=False))
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))

        self.assertEqual(result.exit_code, 0)
        first_patch = next(call for call in client.request_calls if call["method"] == "PATCH")
        area_payload = first_patch["body"]["properties"]["Area"]
        self.assertEqual(area_payload["type"], "relation")
        self.assertEqual(area_payload["relation"]["data_source_id"], "source-Areas")
        self.assertEqual(area_payload["relation"]["single_property"], {})

    def test_dual_property_is_not_added_implicitly(self):
        client = FakeClient(self.existing(full=False))
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))

        self.assertEqual(result.exit_code, 0)
        payload_text = json.dumps([call["body"] for call in client.request_calls if call["method"] == "PATCH"])
        self.assertNotIn("dual_property", payload_text)

    def test_one_way_relation_response_is_recognized_as_matching(self):
        client = FakeClient(self.existing(full=True))
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))

        self.assertEqual(result.exit_code, 0)
        self.assertEqual(client.write_calls(), [])

    def test_partially_created_workspace_is_classified_as_incomplete(self):
        client = FakeClient(self.existing(full=False))
        result = run_build(VALID_ENV, inspect=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 0)
        self.assertIn("incomplete: Tasks, Decisions, Meetings, Approvals", text(result))

    def test_missing_approved_relations_are_resumable(self):
        client = FakeClient(self.existing(full=False))
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 0)
        self.assertIn("Tasks.Area", result.relations_added)
        self.assertEqual(result.containers_created, [])

    def test_wrong_type_properties_remain_hard_conflicts(self):
        existing = self.existing(full=False)
        existing["Areas"]["properties"]["Status"] = {"type": "rich_text", "rich_text": {}}
        client = FakeClient(existing)
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.conflicts, ["Areas"])
        self.assertEqual(client.write_calls(), [])

    def test_wrong_relation_target_remains_hard_conflict(self):
        existing = self.existing(full=True)
        existing["Tasks"]["properties"]["Area"]["relation"]["data_source_id"] = "source-Meetings"
        client = FakeClient(existing)
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.conflicts, ["Tasks"])
        self.assertEqual(client.write_calls(), [])

    def test_all_conflicts_are_detected_before_writes(self):
        existing = self.existing(full=True)
        existing["Tasks"]["properties"]["Status"]["select"]["options"] = [{"name": "Wrong"}]
        existing["Meetings"]["properties"]["Status"] = {"type": "date", "date": {}}
        client = FakeClient(existing)
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(set(result.conflicts), {"Tasks", "Meetings"})
        self.assertEqual(client.write_calls(), [])

    def test_no_new_containers_are_created_during_repair(self):
        client = FakeClient(self.existing(full=False))
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.containers_created, [])
        self.assertFalse(any(call["method"] == "POST" for call in client.request_calls))

    def test_apply_adds_only_missing_relations(self):
        client = FakeClient(self.existing(full=False))
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(len(result.relations_added), 9)
        self.assertTrue(all(call["method"] == "PATCH" for call in client.write_calls()))

    def test_relation_update_targets_owning_data_source(self):
        client = FakeClient(self.existing(full=False))
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))

        self.assertEqual(result.exit_code, 0)
        patch_paths = [call["path"] for call in client.request_calls if call["method"] == "PATCH"]
        self.assertIn("data_sources/source-Tasks", patch_paths)
        self.assertIn("data_sources/source-Decisions", patch_paths)

    def test_second_apply_performs_zero_writes(self):
        client = FakeClient(self.existing(full=False))
        first = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        request_count = len(client.request_calls)
        second = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        second_writes = client.request_calls[request_count:]
        self.assertEqual(first.exit_code, 0)
        self.assertEqual(second.exit_code, 0)
        self.assertEqual([call for call in second_writes if call["method"] in {"POST", "PATCH"}], [])

    def test_api_response_error_is_sanitized_but_diagnostic(self):
        client = FakeClient(self.existing(full=False), fail_update=True)
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertEqual(result.exit_code, 1)
        self.assertIn("status=400", text(result))
        self.assertIn("code=validation_error", text(result))
        self.assertIn("<redacted>", text(result))
        self.assertNotIn(VALID_ENV["NOTION_TOKEN"], text(result))

    def test_validation_failure_on_first_relation_reports_zero_relations_added(self):
        client = FakeClient(self.existing(full=False), fail_on_patch_number=1)
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))

        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.relations_added, [])

    def test_failure_after_success_reports_only_successful_relations(self):
        client = FakeClient(self.existing(full=False), fail_on_patch_number=2)
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))

        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.relations_added, ["Tasks.Area", "Tasks.Related Decision"])

    def test_failed_relation_pass_is_not_reported_as_full_success(self):
        client = FakeClient(self.existing(full=False), fail_update=True)
        result = run_build(VALID_ENV, apply=True, client=client, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertNotEqual(result.exit_code, 0)
        self.assertNotEqual(set(result.complete), set(APPROVED_DATABASES))

    def test_token_remains_redacted(self):
        result = run_build(VALID_ENV, apply=False, schema_path=self.schema_path(BASE_SCHEMA))
        self.assertIn("<redacted>", text(result))
        self.assertNotIn(VALID_ENV["NOTION_TOKEN"], text(result))

    def test_malformed_workspace_schema_fails_safely(self):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        with handle:
            handle.write("{")
        path = Path(handle.name)
        self.paths = getattr(self, "paths", []) + [path]
        result = run_build(VALID_ENV, apply=False, schema_path=path)
        self.assertEqual(result.exit_code, 1)
        self.assertIn("Malformed workspace schema JSON", text(result))

    def test_unsupported_property_types_fail_safely(self):
        schema = deepcopy(BASE_SCHEMA)
        schema["databases"][0]["properties"].append({"name": "Formula", "type": "formula"})
        result = run_build(VALID_ENV, apply=False, schema_path=self.schema_path(schema))
        self.assertEqual(result.exit_code, 1)
        self.assertIn("unsupported property type", text(result))

    def test_relations_resolve_only_to_approved_databases(self):
        schema = deepcopy(BASE_SCHEMA)
        schema["databases"][1]["properties"].append({"name": "Bad Relation", "type": "relation", "relatedDatabase": "Vendors"})
        result = run_build(VALID_ENV, apply=False, schema_path=self.schema_path(schema))
        self.assertEqual(result.exit_code, 1)
        self.assertIn("relates to unapproved database", text(result))


if __name__ == "__main__":
    unittest.main()
