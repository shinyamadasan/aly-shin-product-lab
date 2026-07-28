"""Safe Notion connectivity test for Aly & Pon OS."""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from dotenv import load_dotenv


TEST_PAGE_TITLE = "Aly & Pon Connection Test"
TEST_PARAGRAPH = "The Aly & Pon OS connection is working."
REQUIRED_ENV_VARS = ("NOTION_TOKEN", "NOTION_PARENT_PAGE_ID")
PAGE_ID_RE = re.compile(
    r"^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"
)


class NotionClient(Protocol):
    pages: Any
    blocks: Any


@dataclass
class CheckResult:
    exit_code: int
    messages: list[str]


def redact_secret(value: str | None) -> str:
    if not value:
        return "<missing>"
    return "<redacted>"


def validate_env(env: Mapping[str, str]) -> tuple[dict[str, str], list[str]]:
    errors: list[str] = []
    values: dict[str, str] = {}

    for key in REQUIRED_ENV_VARS:
        value = env.get(key, "").strip()
        if not value:
            errors.append(f"Missing required environment variable: {key}")
        else:
            values[key] = value

    parent_page_id = values.get("NOTION_PARENT_PAGE_ID")
    if parent_page_id and not PAGE_ID_RE.match(parent_page_id):
        errors.append("NOTION_PARENT_PAGE_ID must be a 32-character Notion page ID, with or without hyphens.")

    return values, errors


def load_notion_client(token: str) -> NotionClient:
    from notion_client import Client

    return Client(auth=token)


def rich_text_plain_text(items: list[dict[str, Any]]) -> str:
    return "".join(item.get("plain_text", "") for item in items)


def get_page_title(page: dict[str, Any]) -> str:
    properties = page.get("properties", {})
    for property_value in properties.values():
        if property_value.get("type") == "title":
            return rich_text_plain_text(property_value.get("title", []))
    return ""


def find_existing_child_page(client: NotionClient, parent_page_id: str) -> dict[str, Any] | None:
    cursor: str | None = None

    while True:
        kwargs: dict[str, Any] = {"block_id": parent_page_id, "page_size": 100}
        if cursor:
            kwargs["start_cursor"] = cursor

        response = client.blocks.children.list(**kwargs)
        for child in response.get("results", []):
            if child.get("type") != "child_page":
                continue
            child_id = child.get("id")
            if not child_id:
                continue
            page = client.pages.retrieve(page_id=child_id)
            if get_page_title(page) == TEST_PAGE_TITLE:
                return page

        if not response.get("has_more"):
            return None
        cursor = response.get("next_cursor")


def create_connection_test_page(client: NotionClient, parent_page_id: str) -> dict[str, Any]:
    return client.pages.create(
        parent={"page_id": parent_page_id},
        properties={
            "title": {
                "title": [
                    {
                        "type": "text",
                        "text": {"content": TEST_PAGE_TITLE},
                    }
                ]
            }
        },
        children=[
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [
                        {
                            "type": "text",
                            "text": {"content": TEST_PARAGRAPH},
                        }
                    ]
                },
            }
        ],
    )


def run_check(
    env: Mapping[str, str],
    *,
    apply: bool = False,
    client: NotionClient | None = None,
) -> CheckResult:
    values, errors = validate_env(env)
    messages: list[str] = []

    if errors:
        return CheckResult(1, errors)

    token = values["NOTION_TOKEN"]
    parent_page_id = values["NOTION_PARENT_PAGE_ID"]

    messages.append("Required environment variables are present.")
    messages.append("NOTION_PARENT_PAGE_ID format is valid.")
    messages.append(f"NOTION_TOKEN: {redact_secret(token)}")

    if not apply:
        messages.append("Dry-run mode: no live Notion writes will be performed.")
        messages.append(f"Apply mode would verify access to parent page {parent_page_id}.")
        messages.append(f'Apply mode would look for a direct child page named "{TEST_PAGE_TITLE}".')
        messages.append("Apply mode would create that single child page only if it does not already exist.")
        messages.append("Apply mode would not create databases, edit unrelated pages, delete content, or archive content.")
        return CheckResult(0, messages)

    notion = client if client is not None else load_notion_client(token)

    try:
        notion.pages.retrieve(page_id=parent_page_id)
        messages.append("Configured parent page is accessible.")

        existing_page = find_existing_child_page(notion, parent_page_id)
        if existing_page:
            messages.append(f'Connection test page already exists: "{TEST_PAGE_TITLE}". No creation needed.')
            return CheckResult(0, messages)

        create_connection_test_page(notion, parent_page_id)
        messages.append(f'Created direct child page: "{TEST_PAGE_TITLE}".')
        messages.append("Added one paragraph to the child page.")
        return CheckResult(0, messages)
    except Exception as exc:
        messages.append(f"Notion API operation failed: {exc.__class__.__name__}")
        return CheckResult(1, messages)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Aly & Pon Notion connectivity test.")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Perform the live Notion connectivity check and create the test page if needed.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    load_dotenv()
    result = run_check(os.environ, apply=args.apply)
    for message in result.messages:
        print(message)
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
