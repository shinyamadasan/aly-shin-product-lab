import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.notion_connection_test import (  # noqa: E402
    TEST_PAGE_TITLE,
    TEST_PARAGRAPH,
    run_check,
)


VALID_ENV = {
    "NOTION_TOKEN": "secret_test_token_should_not_appear",
    "NOTION_PARENT_PAGE_ID": "1234567890abcdef1234567890abcdef",
}


def message_text(result):
    return "\n".join(result.messages)


class NotionConnectionTest(unittest.TestCase):
    def test_dry_run_does_not_use_client_or_expose_secret(self):
        client = Mock()

        result = run_check(VALID_ENV, apply=False, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Dry-run mode", message_text(result))
        self.assertIn("<redacted>", message_text(result))
        self.assertNotIn(VALID_ENV["NOTION_TOKEN"], message_text(result))
        client.assert_not_called()

    def test_missing_environment_variables_fail(self):
        result = run_check({}, apply=False)

        self.assertEqual(result.exit_code, 1)
        self.assertIn("Missing required environment variable: NOTION_TOKEN", message_text(result))
        self.assertIn("Missing required environment variable: NOTION_PARENT_PAGE_ID", message_text(result))

    def test_existing_page_detection_skips_creation(self):
        client = Mock()
        client.pages.retrieve.side_effect = [
            {"id": VALID_ENV["NOTION_PARENT_PAGE_ID"]},
            {
                "id": "child-page-id",
                "properties": {
                    "Name": {
                        "type": "title",
                        "title": [{"plain_text": TEST_PAGE_TITLE}],
                    }
                },
            },
        ]
        client.blocks.children.list.return_value = {
            "results": [{"type": "child_page", "id": "child-page-id"}],
            "has_more": False,
        }

        result = run_check(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("No creation needed", message_text(result))
        client.pages.create.assert_not_called()

    def test_page_creation_when_missing(self):
        client = Mock()
        client.pages.retrieve.return_value = {"id": VALID_ENV["NOTION_PARENT_PAGE_ID"]}
        client.blocks.children.list.return_value = {"results": [], "has_more": False}
        client.pages.create.return_value = {"id": "created-page-id"}

        result = run_check(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Created direct child page", message_text(result))
        client.pages.create.assert_called_once()
        kwargs = client.pages.create.call_args.kwargs
        self.assertEqual(kwargs["parent"], {"page_id": VALID_ENV["NOTION_PARENT_PAGE_ID"]})
        self.assertEqual(
            kwargs["properties"]["title"]["title"][0]["text"]["content"],
            TEST_PAGE_TITLE,
        )
        self.assertEqual(
            kwargs["children"][0]["paragraph"]["rich_text"][0]["text"]["content"],
            TEST_PARAGRAPH,
        )

    def test_api_failures_are_reported_without_secret(self):
        client = Mock()
        client.pages.retrieve.side_effect = RuntimeError("contains secret_test_token_should_not_appear")

        result = run_check(VALID_ENV, apply=True, client=client)

        self.assertEqual(result.exit_code, 1)
        self.assertIn("Notion API operation failed: RuntimeError", message_text(result))
        self.assertNotIn(VALID_ENV["NOTION_TOKEN"], message_text(result))

    def test_cli_redacts_secret_in_dry_run(self):
        env = os.environ.copy()
        env.update(VALID_ENV)

        completed = subprocess.run(
            [sys.executable, "scripts/notion_connection_test.py"],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0)
        self.assertIn("<redacted>", completed.stdout)
        self.assertNotIn(VALID_ENV["NOTION_TOKEN"], completed.stdout)
        self.assertNotIn(VALID_ENV["NOTION_TOKEN"], completed.stderr)

    def test_cli_loads_values_from_temporary_dotenv_file(self):
        dotenv_token = "secret_from_temp_dotenv_should_not_appear"

        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8") as dotenv_file:
            dotenv_file.write(
                "\n".join(
                    [
                        f"NOTION_TOKEN={dotenv_token}",
                        f"NOTION_PARENT_PAGE_ID={VALID_ENV['NOTION_PARENT_PAGE_ID']}",
                    ]
                )
            )
            dotenv_path = dotenv_file.name

        old_token = os.environ.pop("NOTION_TOKEN", None)
        old_parent = os.environ.pop("NOTION_PARENT_PAGE_ID", None)
        try:
            self.assertTrue(load_dotenv(dotenv_path=dotenv_path))
            result = run_check(os.environ, apply=False)
        finally:
            if old_token is not None:
                os.environ["NOTION_TOKEN"] = old_token
            else:
                os.environ.pop("NOTION_TOKEN", None)
            if old_parent is not None:
                os.environ["NOTION_PARENT_PAGE_ID"] = old_parent
            else:
                os.environ.pop("NOTION_PARENT_PAGE_ID", None)
            Path(dotenv_path).unlink(missing_ok=True)

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Required environment variables are present.", message_text(result))
        self.assertIn("<redacted>", message_text(result))
        self.assertNotIn(dotenv_token, message_text(result))

    def test_cli_dotenv_does_not_overwrite_existing_process_environment_by_default(self):
        process_token = "secret_from_process_env_should_not_appear"
        dotenv_token = "secret_from_dotenv_should_not_appear"
        process_page_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        dotenv_page_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8") as dotenv_file:
            dotenv_file.write(
                "\n".join(
                    [
                        f"NOTION_TOKEN={dotenv_token}",
                        f"NOTION_PARENT_PAGE_ID={dotenv_page_id}",
                    ]
                )
            )
            dotenv_path = dotenv_file.name

        old_token = os.environ.get("NOTION_TOKEN")
        old_parent = os.environ.get("NOTION_PARENT_PAGE_ID")
        os.environ["NOTION_TOKEN"] = process_token
        os.environ["NOTION_PARENT_PAGE_ID"] = process_page_id
        try:
            self.assertTrue(load_dotenv(dotenv_path=dotenv_path))
            result = run_check(os.environ, apply=False)
        finally:
            if old_token is not None:
                os.environ["NOTION_TOKEN"] = old_token
            else:
                os.environ.pop("NOTION_TOKEN", None)
            if old_parent is not None:
                os.environ["NOTION_PARENT_PAGE_ID"] = old_parent
            else:
                os.environ.pop("NOTION_PARENT_PAGE_ID", None)
            Path(dotenv_path).unlink(missing_ok=True)

        self.assertEqual(result.exit_code, 0)
        self.assertIn(f"Apply mode would verify access to parent page {process_page_id}.", message_text(result))
        self.assertNotIn(dotenv_page_id, message_text(result))
        self.assertNotIn(process_token, message_text(result))
        self.assertNotIn(dotenv_token, message_text(result))


if __name__ == "__main__":
    unittest.main()
