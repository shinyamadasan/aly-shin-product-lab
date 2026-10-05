// Local-only (stdio MCP server + inventory-operator CLI) wiring for InventoryCountService.
//
// Split out of inventory-count-service.ts in TASK-073: this is the ONLY module that touches the local
// filesystem (node:fs, node:path, import.meta.url). The remote HTTP transport -- the Next.js route and
// the Cloudflare Worker -- imports inventory-count-service.ts and its Supabase-backed durable preview
// store only, never this file. A Worker has no stable filesystem and no file URL for its own module,
// so a remote preview must never land on disk; keeping the two apart makes that structural rather
// than a convention. The InventoryCountService interface and its preview/apply/verify flow are
// unchanged.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticatedProductLabClient, ProductLabError } from "./auth.ts";
import {
  InventoryCountService,
  type InventoryCountArtifactStore,
  type InventoryCountPreviewArtifact,
} from "./inventory-count-service.ts";
import { createProductLabReadService } from "./read-service.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PREVIEW_DIR = path.join(ROOT, ".inventory-operator", "previews");

function artifactPath(previewDirectory: string, previewId: string): string {
  if (!/^pc_[a-f0-9]{20}$/.test(previewId)) {
    throw new ProductLabError("preview_error", "Invalid preview id");
  }
  return path.join(previewDirectory, `${previewId}.json`);
}

export function createInventoryCountArtifactStore(
  previewDirectory = DEFAULT_PREVIEW_DIR,
): InventoryCountArtifactStore {
  return {
    async read(previewId) {
      try {
        return JSON.parse(await readFile(artifactPath(previewDirectory, previewId), "utf8")) as InventoryCountPreviewArtifact;
      } catch (error) {
        if (error instanceof ProductLabError) throw error;
        throw new ProductLabError(
          "preview_error",
          `Unable to load preview artifact: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    async save(artifact) {
      await mkdir(previewDirectory, { recursive: true });
      const target = artifactPath(previewDirectory, artifact.preview.preview_id);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    },
  };
}

export function createInventoryCountService(
  env: NodeJS.ProcessEnv = process.env,
  previewDirectory = DEFAULT_PREVIEW_DIR,
): InventoryCountService {
  return new InventoryCountService(
    createProductLabReadService(env),
    () => authenticatedProductLabClient(env),
    createInventoryCountArtifactStore(previewDirectory),
  );
}
