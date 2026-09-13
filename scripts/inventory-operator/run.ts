#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PhysicalCountIntent } from "./core.ts";
import { createInventoryCountService } from "../product-lab/inventory-count-service.ts";
import { createProductLabReadService } from "../product-lab/read-service.ts";
const readService = createProductLabReadService();
const inventoryCountService = createInventoryCountService();

function fail(message: string): never {
  throw new Error(message);
}

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function inventoryList() {
  const result = await readService.inventoryList();
  output(result.inventory.map((ingredient) => ({
    id: ingredient.id,
    name: ingredient.canonical_name,
    active: ingredient.active,
    current_quantity: ingredient.current_quantity,
    base_unit: ingredient.canonical_unit,
    inventory_reconciled_at: ingredient.inventory_reconciled_at,
    cost_reconciled_at: ingredient.cost_reconciled_at,
  })));
}

async function ingredientMatch() {
  const name = flag("name") ?? fail("ingredient:match requires --name");
  output(await readService.ingredientMatch(name));
}

async function countPreview() {
  const inputPath = flag("input") ?? fail("inventory:count-preview requires --input <structured-intent.json>");
  const intent = JSON.parse(await readFile(path.resolve(inputPath), "utf8")) as PhysicalCountIntent;
  const preview = await inventoryCountService.preview(intent);
  output(preview);
  if (!preview.can_apply) process.exitCode = 2;
}

async function countApply() {
  const previewId = flag("preview-id") ?? fail("inventory:count-apply requires --preview-id");
  const approvalCode = flag("approval-code") ?? fail("inventory:count-apply requires --approval-code");
  output(await inventoryCountService.apply(previewId, approvalCode));
}

async function inventoryVerify() {
  const previewId = flag("preview-id") ?? fail("inventory:verify requires --preview-id");
  output(await inventoryCountService.verify(previewId));
}

function help() {
  output({
    usage: [
      "inventory:list",
      "ingredient:match --name <source-name>",
      "inventory:count-preview --input <structured-intent.json>",
      "inventory:count-apply --preview-id <id> --approval-code <code>",
      "inventory:verify --preview-id <id>",
    ],
  });
}

const commands: Record<string, () => Promise<void> | void> = {
  "inventory:list": inventoryList,
  "ingredient:match": ingredientMatch,
  "inventory:count-preview": countPreview,
  "inventory:count-apply": countApply,
  "inventory:verify": inventoryVerify,
  help,
};

try {
  const command = process.argv[2] ?? "help";
  const handler = commands[command] ?? fail(`Unknown inventory operator command: ${command}`);
  await handler();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
