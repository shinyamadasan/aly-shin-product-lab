// Local-only (stdio MCP server) wiring for PurchaseService.
//
// The purchase sibling of scripts/product-lab/inventory-count-service-local.ts: this is the ONLY
// purchase module that touches the local filesystem (node:fs, node:path, import.meta.url). The remote
// HTTP transport -- the Next.js route and the Cloudflare Worker -- imports purchase-service.ts and its
// Supabase-backed durable store only, never this file. A Worker has no stable filesystem and no file
// URL for its own module, so a remote preview must never land on disk; keeping the two apart makes
// that structural. PurchaseService and its preview -> apply -> verify flow are the same code.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticatedProductLabClient } from "../product-lab/auth.ts";
import { createProductLabReadService } from "../product-lab/read-service.ts";
import type { PurchasePreview } from "../purchase-operator/core.ts";
import {
  PURCHASE_PREVIEW_ID_PATTERN,
  PurchaseDomainError,
  PurchaseService,
  type PurchaseApplyRecord,
  type PurchaseArtifact,
  type PurchaseArtifactStore,
} from "./purchase-service.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PREVIEW_DIR = path.join(ROOT, ".purchase-operator", "previews");
const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

function artifactPath(previewDirectory: string, previewId: string): string {
  if (!PURCHASE_PREVIEW_ID_PATTERN.test(previewId)) {
    throw new PurchaseDomainError("purchase_preview_not_found", "preview_error", "That is not a purchase preview id.");
  }
  return path.join(previewDirectory, `${previewId}.json`);
}

function failure(action: string, error: unknown): PurchaseDomainError {
  return new PurchaseDomainError(
    "purchase_store_failed",
    "preview_error",
    `Product Lab could not ${action} the local purchase preview. Nothing was posted by this step.`,
    `Unable to ${action} local purchase preview artifact: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// Transient approval state, not a ledger; ignored by git (.purchase-operator/). Same primitives, and
// the same "never overwrite apply state" rules (enforced once, in PurchaseService), as the durable store.
export function createPurchaseArtifactStore(previewDirectory = DEFAULT_PREVIEW_DIR): PurchaseArtifactStore {
  const read = async (previewId: string): Promise<PurchaseArtifact | null> => {
    const target = artifactPath(previewDirectory, previewId);
    let text: string;
    try {
      text = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw failure("load", error);
    }
    try {
      return JSON.parse(text) as PurchaseArtifact;
    } catch (error) {
      throw failure("parse", error);
    }
  };
  const write = async (artifact: PurchaseArtifact) => {
    try {
      await mkdir(previewDirectory, { recursive: true });
      const target = artifactPath(previewDirectory, artifact.preview.preview_id);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      if (error instanceof PurchaseDomainError) throw error;
      throw failure("save", error);
    }
  };
  const freshWindow = () => new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString();
  const update = async (previewId: string, change: (artifact: PurchaseArtifact) => PurchaseArtifact, action: string) => {
    const artifact = await read(previewId);
    if (!artifact) throw failure(action, new Error("no artifact exists"));
    await write(change(artifact));
  };
  return {
    read,
    async insertIfAbsent(preview: PurchasePreview) {
      if (await read(preview.preview_id)) return;
      await write({ preview, apply_result: null, verified_at: null, expires_at: freshWindow() });
    },
    async refreshExpired(preview: PurchasePreview) {
      const existing = await read(preview.preview_id);
      if (!existing || existing.apply_result !== null) return;
      await write({ ...existing, preview, expires_at: freshWindow() });
    },
    recordApply: (previewId: string, record: PurchaseApplyRecord) =>
      update(previewId, (artifact) => ({ ...artifact, apply_result: record }), "record the apply progress of"),
    recordVerified: (previewId: string, verifiedAt: string) =>
      update(previewId, (artifact) => ({ ...artifact, verified_at: verifiedAt }), "record the verification of"),
  };
}

export function createPurchaseService(
  env: NodeJS.ProcessEnv = process.env,
  previewDirectory = DEFAULT_PREVIEW_DIR,
): PurchaseService {
  return new PurchaseService(
    createProductLabReadService(env),
    // A fresh authenticated client per call, as the count service does: never reuse preview-time auth.
    () => authenticatedProductLabClient(env),
    createPurchaseArtifactStore(previewDirectory),
  );
}
