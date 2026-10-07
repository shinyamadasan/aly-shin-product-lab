// Product Lab MCP -- Purchases V3 application service: preview -> apply -> verify.
//
// WORKER-SAFE BY CONSTRUCTION. This module is in the Cloudflare Worker import graph, so it must
// never import Node's filesystem, path or url modules or read its own module URL, and it keeps no durable
// state of its own. The filesystem preview store and the env-configured stdio factory live in this
// file's "-local" sibling, which only the stdio entrypoint imports. (tests/product-lab-mcp-worker
// .test.ts asserts the Worker graph contains neither.)
//
// AUTHORITIES (nothing is reimplemented here):
//   * mutation:  public.post_raw_purchase, ONE LINE AT A TIME. A multi-line purchase is therefore NOT
//                atomic, and nothing here pretends otherwise: a failure after earlier lines committed
//                is reported as PARTIALLY_APPLIED and committed lines are never rolled back.
//   * idempotency: each line's operation id derives from occasion_id + row number
//                (purchase-operator/core.ts purchaseLineOperationId); the database's claim_mutation
//                replays an identical retry and REJECTS a changed payload under the same id.
//   * artifacts: public.product_lab_mcp_purchase_previews (owner-scoped RLS). The preview stored there
//                is the only source of what apply writes; the client never re-supplies it.
//
// THE RPC RESULT IS NEVER PROOF. claim_mutation retains a receipt forever, so a retry of a line whose
// purchase was later reversed (Safe Purchase Delete) replays a result naming rows that no longer
// exist. Every committed line is therefore read back by id from the supply and ledger tables and
// compared with the approved line; a missing or mismatched row fails closed, and the owner is told a
// NEW occasion_id is required. Receipts are never touched.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertPurchasePreviewApproved,
  assertPurchasePreviewIntegrity,
  buildPurchasePreview,
  classifyPurchaseApply,
  purchaseLineOperationId,
  purchaseLineRpcArgs,
  type PurchaseApplyStatus,
  type PurchaseIntent,
  type PurchaseLineResult,
  type PurchasePreview,
} from "../purchase-operator/core.ts";
import { ProductLabError, type ProductLabErrorCode } from "../product-lab/auth.ts";
import {
  createProductLabReadServiceForClient,
  type ProductLabReadService,
} from "../product-lab/read-service.ts";

export const PURCHASE_PREVIEW_ID_PATTERN = /^pu_[a-f0-9]{20}$/;
const PREVIEW_TABLE = "product_lab_mcp_purchase_previews";
const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---- errors -----------------------------------------------------------------------------------

export type PurchaseErrorCode =
  | "purchase_preview_not_found"
  | "purchase_preview_expired"
  | "purchase_approval_mismatch"
  | "purchase_preview_blocked"
  | "purchase_preview_integrity_failed"
  | "purchase_occasion_collision"
  | "purchase_not_authorized"
  | "purchase_reversed_or_missing"
  | "purchase_progress_not_saved"
  | "purchase_line_rejected"
  | "purchase_apply_failed"
  | "purchase_not_applied"
  | "purchase_verification_failed"
  | "purchase_store_failed";

// A ProductLabError (so existing handling and the internal category keep working) that also carries a
// purchase-domain code and an owner-facing message. `message` stays the internal detail (it may name a
// database error); `publicMessage` is the only thing a tool caller is shown.
export class PurchaseDomainError extends ProductLabError {
  readonly purchaseCode: PurchaseErrorCode;
  readonly publicMessage: string;

  constructor(purchaseCode: PurchaseErrorCode, category: ProductLabErrorCode, publicMessage: string, detail?: string) {
    super(category, detail ?? publicMessage);
    this.name = "PurchaseDomainError";
    this.purchaseCode = purchaseCode;
    this.publicMessage = publicMessage;
  }
}

const NEW_OCCASION = "Create a NEW occasion_id for any replacement purchase; never retry or edit this one.";

const COLLISION_MESSAGE = "The same occasion/line identity has already been used for a different approved purchase payload. "
  + "Create a NEW occasion_id rather than retrying or editing this purchase.";

function reversedOrMissing(rowNumber: number, why: string): PurchaseDomainError {
  return new PurchaseDomainError(
    "purchase_reversed_or_missing",
    "apply_failed",
    `Line ${rowNumber}'s purchase rows are ${why}. That purchase was probably reversed or deleted after it was posted `
      + `(retrying an already-used operation replays the old receipt, it does not post again). `
      + `Nothing was reposted and no receipt was touched. ${NEW_OCCASION}`,
  );
}

// ---- stored shapes ----------------------------------------------------------------------------

export type PurchaseApplyRecord = {
  version: 1;
  status: PurchaseApplyStatus;
  preview_id: string;
  occasion_id: string;
  lines: PurchaseLineResult[];
  updated_at: string;
};

export type PurchaseArtifact = {
  preview: PurchasePreview;
  // Raw stored JSON: parsed defensively (parseApplyRecord) by whoever needs it, never trusted blindly.
  apply_result: unknown | null;
  verified_at: string | null;
  expires_at: string;
};

// Deliberately dumb primitives: the preview/refresh/never-clobber decisions live once, in
// PurchaseService.persistPreview, so the durable store and the local store cannot drift apart.
export type PurchaseArtifactStore = {
  read(previewId: string): Promise<PurchaseArtifact | null>;
  // Insert only when absent. Never touches an existing row.
  insertIfAbsent(preview: PurchasePreview): Promise<void>;
  // Replace preview + a fresh 24h window, only while the artifact has never been applied.
  refreshExpired(preview: PurchasePreview): Promise<void>;
  // Set apply_result and nothing else. Throws if no artifact was updated.
  recordApply(previewId: string, record: PurchaseApplyRecord): Promise<void>;
  // Set verified_at and nothing else. Throws if no artifact was updated.
  recordVerified(previewId: string, verifiedAt: string): Promise<void>;
};

// ---- durable store ----------------------------------------------------------------------------

function storeFailure(action: string, error: { message: string }): PurchaseDomainError {
  return new PurchaseDomainError(
    "purchase_store_failed",
    "preview_error",
    `Product Lab could not ${action} the purchase preview. Nothing was posted by this step. Try again; if it keeps failing, tell the owner.`,
    `Unable to ${action} purchase preview artifact: ${error.message}`,
  );
}

// Durable, owner-scoped artifact storage for the remote path. `client` is always a request-scoped,
// already-authenticated owner client; RLS (owner_id = auth.uid()) -- not this code -- is what makes
// "owner A cannot read or touch owner B's artifact" true. Every write below is the narrowest shape:
// the first save is an insert that ignores a duplicate, never an upsert that could overwrite, and
// no write ever sends apply_result = null or verified_at = null. The database's own guard trigger
// (20261005130000) is the final net, not the plan.
export function createDurablePurchaseArtifactStore(client: SupabaseClient): PurchaseArtifactStore {
  return {
    async read(previewId) {
      const { data, error } = await client
        .from(PREVIEW_TABLE)
        .select("preview,apply_result,verified_at,expires_at")
        .eq("preview_id", previewId)
        .maybeSingle();
      if (error) throw storeFailure("load", error);
      if (!data) return null;
      return {
        preview: data.preview as PurchasePreview,
        apply_result: data.apply_result ?? null,
        verified_at: (data.verified_at ?? null) as string | null,
        expires_at: data.expires_at as string,
      };
    },
    async insertIfAbsent(preview) {
      const { error } = await client.from(PREVIEW_TABLE).upsert(
        { preview_id: preview.preview_id, occasion_id: preview.occasion_id, payload_hash: preview.payload_hash, preview },
        { onConflict: "owner_id,preview_id", ignoreDuplicates: true },
      );
      if (error) throw storeFailure("save", error);
    },
    async refreshExpired(preview) {
      const createdAt = new Date();
      const { error } = await client
        .from(PREVIEW_TABLE)
        .update({
          preview,
          created_at: createdAt.toISOString(),
          expires_at: new Date(createdAt.getTime() + APPROVAL_WINDOW_MS).toISOString(),
        })
        .eq("preview_id", preview.preview_id)
        .is("apply_result", null);
      if (error) throw storeFailure("refresh", error);
    },
    async recordApply(previewId, record) {
      const { data, error } = await client
        .from(PREVIEW_TABLE)
        .update({ apply_result: record })
        .eq("preview_id", previewId)
        .select("preview_id");
      if (error) throw storeFailure("record the apply progress of", error);
      if (!data || data.length === 0) throw storeFailure("record the apply progress of", { message: "no artifact was updated" });
    },
    async recordVerified(previewId, verifiedAt) {
      const { data, error } = await client
        .from(PREVIEW_TABLE)
        .update({ verified_at: verifiedAt })
        .eq("preview_id", previewId)
        .select("preview_id");
      if (error) throw storeFailure("record the verification of", error);
      if (!data || data.length === 0) throw storeFailure("record the verification of", { message: "no artifact was updated" });
    },
  };
}

// ---- views returned to MCP callers ------------------------------------------------------------

export type PurchasePreviewRowView = {
  row_number: number;
  raw_name: string;
  ingredient: { id: string; name: string } | null;
  match_status: PurchasePreview["rows"][number]["match_status"];
  match_type: PurchasePreview["rows"][number]["match_type"];
  match_candidates: Array<{ ingredient_id: string; ingredient_name: string; active: boolean; reason: string }>;
  entered_quantity: number | null;
  entered_unit: string | null;
  converted_quantity: number | null;
  base_unit: string | null;
  total_price: number | null;
  brand: string | null;
  evidence: {
    current_quantity: number | null;
    current_average_unit_cost: number | null;
    inventory_reconciled_at: string | null;
  };
  errors: string[];
};

export type PurchasePreviewView = {
  preview_id: string;
  approval_code: string;
  can_apply: boolean;
  occasion_id: string;
  supplier: string | null;
  purchase_date: string | null;
  source_note: string | null;
  total_price: number;
  rows: PurchasePreviewRowView[];
  errors: string[];
  // false only when the preview could not be stored (no usable occasion_id); it cannot be applied.
  stored: boolean;
  expires_at: string | null;
  apply_status: PurchaseApplyStatus | null;
  notice: string;
};

export type PurchaseLineView = {
  row_number: number;
  operation_id: string;
  ingredient_id: string;
  ingredient_name: string;
  outcome: PurchaseLineResult["outcome"];
  supply_id: string | null;
  transaction_id: string | null;
  quantity_after: number | null;
  average_unit_cost: number | null;
  // As returned by post_raw_purchase when it was posted; null when the database does not report it
  // (before Cost System Simplification V4) or the value was not observed.
  cost_trusted: boolean | null;
  error: string | null;
};

export type PurchaseApplied = {
  status: Exclude<PurchaseApplyStatus, "NOT_APPLIED">;
  preview_id: string;
  occasion_id: string;
  supplier: string;
  purchase_date: string;
  total_lines: number;
  committed_lines: number;
  lines: PurchaseLineView[];
  failure: { row_number: number; code: PurchaseErrorCode; message: string } | null;
  message: string;
  next_step: string;
};

export type PurchaseVerificationRow = {
  row_number: number;
  ingredient: string;
  supplier: string;
  purchase_date: string;
  brand: string | null;
  entered_quantity: number;
  entered_unit: string;
  total_price: number;
  base_unit: string;
  quantity_before: number;
  quantity_change: number;
  quantity_after: number;
  supply_id: string;
  transaction_id: string;
  // Recorded when the line was posted (null before V4, or when not observed).
  cost_trusted_at_post: boolean | null;
  // What the ingredient looks like NOW. Observed only: later movements are valid and are not compared.
  current_observed: {
    current_quantity: number;
    average_unit_cost: number | null;
    cost_reconciled_at: string | null;
  } | null;
};

export type PurchaseVerified = {
  status: "verified" | "partial";
  preview_id: string;
  occasion_id: string;
  supplier: string;
  purchase_date: string;
  apply_status: PurchaseApplyStatus;
  total_lines: number;
  verified_lines: number;
  uncommitted_rows: number[];
  total_spent: number;
  rows: PurchaseVerificationRow[];
  note: string;
};

// ---- helpers ----------------------------------------------------------------------------------

const COMMITTED = new Set<PurchaseLineResult["outcome"]>(["applied", "replayed"]);
const isCommitted = (line: PurchaseLineResult) => COMMITTED.has(line.outcome);
const OUTCOMES = new Set<string>(["applied", "replayed", "failed", "not_attempted"]);
const STATUSES = new Set<string>(["APPLIED", "PARTIALLY_APPLIED", "REPLAYED", "NOT_APPLIED"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const textOrNull = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

function sameNumber(a: unknown, b: number): boolean {
  const left = typeof a === "string" ? Number(a) : a;
  return typeof left === "number" && Number.isFinite(left) && Math.abs(left - b) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(b));
}

function notStarted(preview: PurchasePreview, row: PurchasePreview["rows"][number]): PurchaseLineResult {
  return {
    row_number: row.row_number,
    operation_id: purchaseLineOperationId(preview.occasion_id, row.row_number),
    ingredient_id: row.canonical_ingredient_id as string,
    ingredient_name: row.canonical_ingredient_name as string,
    outcome: "not_attempted",
    supply_id: null,
    transaction_id: null,
    quantity_after: null,
    average_unit_cost: null,
    cost_trusted: null,
    error: null,
  };
}

function integrityFailure(detail: string): PurchaseDomainError {
  return new PurchaseDomainError(
    "purchase_preview_integrity_failed",
    "preview_error",
    "The stored purchase preview or its apply progress failed its integrity check, so this step posted nothing. Do not recreate or repost this purchase until purchase history has been reviewed.",
    detail,
  );
}

// Defensive parse of the stored apply_result: it was written by this service, but it is database
// content, and a resume trusts it to decide which lines are already committed.
export function parseApplyRecord(raw: unknown, preview: PurchasePreview): PurchaseApplyRecord {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.lines) || raw.lines.length !== preview.rows.length) {
    throw integrityFailure("Stored apply progress is malformed or does not match the preview's lines");
  }
  const storedLines: unknown[] = raw.lines;
  const lines = preview.rows.map((row, index): PurchaseLineResult => {
    const stored = storedLines[index];
    const base = notStarted(preview, row);
    if (!isObject(stored) || stored.row_number !== row.row_number || stored.operation_id !== base.operation_id
      || stored.ingredient_id !== base.ingredient_id || typeof stored.outcome !== "string" || !OUTCOMES.has(stored.outcome)) {
      throw integrityFailure(`Stored apply progress for line ${row.row_number} does not match the approved preview`);
    }
    const outcome = stored.outcome as PurchaseLineResult["outcome"];
    const supplyId = textOrNull(stored.supply_id);
    const transactionId = textOrNull(stored.transaction_id);
    if (COMMITTED.has(outcome) && (!supplyId || !transactionId)) {
      throw integrityFailure(`Stored apply progress for line ${row.row_number} claims it is committed without its row ids`);
    }
    return {
      ...base,
      outcome,
      supply_id: COMMITTED.has(outcome) ? supplyId : null,
      transaction_id: COMMITTED.has(outcome) ? transactionId : null,
      quantity_after: numberOrNull(stored.quantity_after),
      average_unit_cost: numberOrNull(stored.average_unit_cost),
      cost_trusted: typeof stored.cost_trusted === "boolean" ? stored.cost_trusted : null,
      error: typeof stored.error === "string" ? stored.error : null,
    };
  });
  return {
    version: 1,
    status: typeof raw.status === "string" && STATUSES.has(raw.status) ? (raw.status as PurchaseApplyStatus) : classifyPurchaseApply(lines),
    preview_id: preview.preview_id,
    occasion_id: preview.occasion_id,
    lines,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date(0).toISOString(),
  };
}

function lineView(line: PurchaseLineResult, outcome = line.outcome): PurchaseLineView {
  return {
    row_number: line.row_number,
    operation_id: line.operation_id,
    ingredient_id: line.ingredient_id,
    ingredient_name: line.ingredient_name,
    outcome,
    supply_id: line.supply_id,
    transaction_id: line.transaction_id,
    quantity_after: line.quantity_after,
    average_unit_cost: line.average_unit_cost,
    cost_trusted: line.cost_trusted,
    error: line.error,
  };
}

// Map a post_raw_purchase failure to a purchase-domain error. The database's RAISE messages are
// written for the operator ("Verify the physical stock of ... before posting"), so the stock/validation
// refusals are surfaced; anything unrecognized gets a generic message with the detail kept internal.
export function mapPostRawPurchaseError(error: { code?: string | null; message?: string | null }, rowNumber: number): PurchaseDomainError {
  const code = error.code ?? "";
  const message = error.message ?? "unknown database error";
  if (code === "42501") {
    return new PurchaseDomainError(
      "purchase_not_authorized", "authorization_failed",
      "Only the Product Lab owner may post a purchase. Nothing was posted for this line.",
      `post_raw_purchase refused line ${rowNumber}: ${message}`,
    );
  }
  if (code === "23514" && /already used for a different request/i.test(message)) {
    return new PurchaseDomainError(
      "purchase_occasion_collision", "apply_failed", COLLISION_MESSAGE,
      `claim_mutation refused line ${rowNumber} (23514): ${message}`,
    );
  }
  if (["22023", "23514", "40001", "55P03", "P0001"].includes(code)) {
    return new PurchaseDomainError(
      "purchase_line_rejected", "apply_failed",
      `Product Lab rejected line ${rowNumber}: ${message}`,
      `post_raw_purchase refused line ${rowNumber} (${code}): ${message}`,
    );
  }
  return new PurchaseDomainError(
    "purchase_apply_failed", "apply_failed",
    `Line ${rowNumber} could not be posted because of an unexpected database failure. It was not recorded as committed; retrying is safe.`,
    `post_raw_purchase failed for line ${rowNumber}${code ? ` (${code})` : ""}: ${message}`,
  );
}

type LineReadBack =
  | { ok: true; supplyId: string; transactionId: string; before: number; change: number; after: number }
  | { ok: false; kind: "missing" | "mismatch"; problems: string[] };

type RpcResult = {
  supply_id: string;
  transaction_id: string;
  quantity_after: number | null;
  average_unit_cost: number | null;
  cost_trusted: boolean | null;
};

function parseRpcResult(data: unknown, rowNumber: number): RpcResult {
  if (!isObject(data) || typeof data.supply_id !== "string" || !data.supply_id
    || typeof data.transaction_id !== "string" || !data.transaction_id) {
    throw new PurchaseDomainError(
      "purchase_apply_failed", "apply_failed",
      `Line ${rowNumber} returned an unrecognized result, so it was not recorded as committed. Retrying is safe: the same operation id replays instead of reposting.`,
      `post_raw_purchase returned an unexpected result for line ${rowNumber}`,
    );
  }
  return {
    supply_id: data.supply_id,
    transaction_id: data.transaction_id,
    quantity_after: numberOrNull(data.quantity_after),
    average_unit_cost: numberOrNull(data.average_unit_cost),
    // Missing before V4. Missing means "unknown", never false.
    cost_trusted: typeof data.cost_trusted === "boolean" ? data.cost_trusted : null,
  };
}

export class PurchaseService {
  private readonly readService: Pick<ProductLabReadService, "loadState">;
  private readonly authenticatedClient: () => Promise<SupabaseClient>;
  private readonly artifacts: PurchaseArtifactStore;

  constructor(
    readService: Pick<ProductLabReadService, "loadState">,
    authenticatedClient: () => Promise<SupabaseClient>,
    artifacts: PurchaseArtifactStore,
  ) {
    this.readService = readService;
    this.authenticatedClient = authenticatedClient;
    this.artifacts = artifacts;
  }

  // ---- preview --------------------------------------------------------------------------------

  async preview(intent: PurchaseIntent): Promise<PurchasePreviewView> {
    const state = await this.readService.loadState();
    const built = buildPurchasePreview({ intent, ...state });
    // A preview with no usable occasion_id cannot satisfy the table's identity checks. It is blocked
    // anyway, so it is shown but not stored.
    const artifact = built.occasion_id ? await this.persistPreview(built) : null;
    return previewView(artifact?.preview ?? built, artifact);
  }

  // The one place the "never overwrite apply state" rules live:
  //   * first save            -> insert, ignoring a duplicate (never an upsert that could overwrite)
  //   * existing, applied     -> use the stored artifact untouched
  //   * existing, valid       -> use the stored artifact as-is
  //   * existing, expired and never applied -> refresh preview + a new 24h window
  private async persistPreview(built: PurchasePreview): Promise<PurchaseArtifact> {
    await this.artifacts.insertIfAbsent(built);
    let artifact = await this.artifacts.read(built.preview_id);
    if (!artifact) throw storeFailure("read back", { message: "the saved artifact is not visible to this session" });
    if (artifact.apply_result === null && isExpired(artifact)) {
      await this.artifacts.refreshExpired(built);
      artifact = await this.artifacts.read(built.preview_id);
      if (!artifact) throw storeFailure("read back", { message: "the refreshed artifact is not visible to this session" });
    }
    return artifact;
  }

  // ---- apply ----------------------------------------------------------------------------------

  async apply(previewId: string, approvalCode: string): Promise<PurchaseApplied> {
    // A fresh client performs auth.getUser again for every apply. Never reuse preview-time auth.
    const client = await this.authenticatedClient();
    const artifact = await this.loadArtifact(previewId);
    const preview = artifact.preview;
    this.assertApprovable(preview, approvalCode);

    // A malformed or untrustworthy apply_result fails closed here (integrity error), expired or not:
    // it is never treated as "never started", and nothing is reposted.
    const record = artifact.apply_result === null ? null : parseApplyRecord(artifact.apply_result, preview);

    // Expiry bounds STARTING an approval, not safely continuing one. Once durable progress shows at
    // least one validly recorded committed line, the stored approved artifact is the authority and
    // the purchase may resume (or be replayed) after the window closes -- every recorded line is still
    // read back below. With no confirmable progress, an expired preview is refused BEFORE any RPC:
    // calling post_raw_purchase just to discover whether an earlier crash-gap commit happened could
    // instead START a genuinely never-started purchase on an expired approval.
    if (isExpired(artifact) && !record?.lines.some(isCommitted)) {
      throw new PurchaseDomainError(
        "purchase_preview_expired", "preview_error",
        "This purchase preview has expired and no durable apply progress can be confirmed. "
          + "Do not recreate or repost it until purchase history is reviewed.",
      );
    }
    // What is durably recorded. Committed lines here are only ever advanced, never cleared.
    const stored: PurchaseLineResult[] = record
      ? record.lines
      : preview.rows.map((row) => notStarted(preview, row));
    const result: PurchaseLineResult[] = preview.rows.map((row) => notStarted(preview, row));
    let failure: PurchaseApplied["failure"] = null;

    for (const row of preview.rows) {
      const index = row.row_number - 1;
      const recorded = stored[index];

      if (isCommitted(recorded)) {
        // Already committed by an earlier call: prove the rows still exist and still match, never
        // call the RPC again just to confirm it.
        const readBack = await this.readBackLine(client, preview, recorded);
        if (!readBack.ok) throw this.readBackFailure(row.row_number, readBack, "apply_failed");
        result[index] = { ...recorded, outcome: "replayed" };
        continue;
      }

      let posted: RpcResult;
      try {
        posted = await this.postLine(client, preview, row.row_number);
      } catch (error) {
        if (!(error instanceof PurchaseDomainError)) throw error;
        failure = { row_number: row.row_number, code: error.purchaseCode, message: error.publicMessage };
        result[index] = { ...notStarted(preview, row), outcome: "failed", error: error.publicMessage };
        // Everything after the failed line stays not_attempted: apply stops on the first failure.
        if (!stored.some(isCommitted)) throw error; // nothing committed anywhere: NOT_APPLIED
        stored[index] = result[index];
        await this.saveProgress(preview, stored, { bestEffort: true });
        break;
      }

      const committed: PurchaseLineResult = {
        ...notStarted(preview, row),
        outcome: "applied", // a crash-recovered replay is indistinguishable from a first post; both read "applied"
        supply_id: posted.supply_id,
        transaction_id: posted.transaction_id,
        quantity_after: posted.quantity_after,
        average_unit_cost: posted.average_unit_cost,
        cost_trusted: posted.cost_trusted,
      };
      // Never trust the RPC result alone (it may be a replay of a since-reversed purchase).
      const readBack = await this.readBackLine(client, preview, committed);
      if (!readBack.ok) throw this.readBackFailure(row.row_number, readBack, "apply_failed");

      stored[index] = committed;
      result[index] = committed;
      // Persist BEFORE the next line. If this fails the line is still committed in the database; a retry
      // replays it through claim_mutation (same operation id) and read-back reconstructs the progress.
      await this.saveProgress(preview, stored, { bestEffort: false, afterLine: row.row_number });
    }

    const status = classifyPurchaseApply(result);
    if (status === "NOT_APPLIED") {
      // Unreachable: a failure with nothing committed already threw above.
      throw new PurchaseDomainError("purchase_apply_failed", "apply_failed", "No line of this purchase was applied.");
    }
    return appliedView(preview, status, result, failure);
  }

  private assertApprovable(preview: PurchasePreview, approvalCode: string): void {
    if (!preview.can_apply || preview.errors.length > 0) {
      throw new PurchaseDomainError(
        "purchase_preview_blocked", "preview_error",
        "This purchase preview is blocked by errors and cannot be applied. Fix the errors, run purchase_preview again, and get a new approval.",
      );
    }
    try {
      assertPurchasePreviewIntegrity(preview);
    } catch (error) {
      throw integrityFailure(error instanceof Error ? error.message : String(error));
    }
    try {
      assertPurchasePreviewApproved(preview, approvalCode);
    } catch {
      throw new PurchaseDomainError(
        "purchase_approval_mismatch", "preview_error",
        "The approval code does not match this exact preview. Nothing was posted. Use the code from the latest preview, supplied by the owner in a new message.",
      );
    }
  }

  private async loadArtifact(previewId: string): Promise<PurchaseArtifact> {
    if (!PURCHASE_PREVIEW_ID_PATTERN.test(previewId)) {
      throw new PurchaseDomainError("purchase_preview_not_found", "preview_error", "That is not a purchase preview id. Purchase previews look like pu_ followed by 20 hex characters.");
    }
    const artifact = await this.artifacts.read(previewId);
    if (!artifact) {
      throw new PurchaseDomainError("purchase_preview_not_found", "preview_error", "No purchase preview with that id exists for this owner. Run purchase_preview first.");
    }
    return artifact;
  }

  private async postLine(client: SupabaseClient, preview: PurchasePreview, rowNumber: number): Promise<RpcResult> {
    const args = purchaseLineRpcArgs(preview, rowNumber);
    let data: unknown;
    let error: { code?: string | null; message?: string | null } | null;
    try {
      ({ data, error } = await client.rpc("post_raw_purchase", args));
    } catch (thrown) {
      throw mapPostRawPurchaseError({ message: thrown instanceof Error ? thrown.message : String(thrown) }, rowNumber);
    }
    if (error) throw mapPostRawPurchaseError(error, rowNumber);
    return parseRpcResult(data, rowNumber);
  }

  private async saveProgress(
    preview: PurchasePreview,
    lines: PurchaseLineResult[],
    options: { bestEffort: boolean; afterLine?: number },
  ): Promise<void> {
    const record: PurchaseApplyRecord = {
      version: 1,
      status: classifyPurchaseApply(lines),
      preview_id: preview.preview_id,
      occasion_id: preview.occasion_id,
      lines,
      updated_at: new Date().toISOString(),
    };
    try {
      await this.artifacts.recordApply(preview.preview_id, record);
    } catch (error) {
      if (options.bestEffort) return; // the original failure is what the caller must see
      throw new PurchaseDomainError(
        "purchase_progress_not_saved", "apply_failed",
        `Line ${options.afterLine} was posted in Product Lab, but its progress could not be saved. Nothing is duplicated by retrying: `
          + "call purchase_apply again with the same preview_id and approval_code and it will recognize the posted line.",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private readBackFailure(rowNumber: number, readBack: Extract<LineReadBack, { ok: false }>, category: ProductLabErrorCode): PurchaseDomainError {
    if (readBack.kind === "missing") return reversedOrMissing(rowNumber, "missing");
    const error = reversedOrMissing(rowNumber, `no longer what was approved (${readBack.problems.join("; ")})`);
    return new PurchaseDomainError(error.purchaseCode, category, error.publicMessage, error.publicMessage);
  }

  // Read the line's supply and ledger rows BY ID and compare them with the approved line. This is the
  // check that makes a replayed claim_mutation result safe to act on.
  private async readBackLine(client: SupabaseClient, preview: PurchasePreview, line: PurchaseLineResult): Promise<LineReadBack> {
    const args = purchaseLineRpcArgs(preview, line.row_number);
    const [supplyResult, transactionResult] = await Promise.all([
      client.from("supply_entries")
        .select("id,ingredient_id,brand_name,supplier_name,purchase_date,pack_quantity,unit,total_cost,notes")
        .eq("id", line.supply_id as string)
        .maybeSingle(),
      client.from("inventory_transactions")
        .select("id,ingredient_id,transaction_type,source_type,source_id,quantity_before,quantity_change,quantity_after")
        .eq("id", line.transaction_id as string)
        .maybeSingle(),
    ]);
    if (supplyResult.error || transactionResult.error) {
      throw new PurchaseDomainError(
        "purchase_apply_failed", "apply_failed",
        `Line ${line.row_number}'s purchase rows could not be read back, so it was not confirmed. Retrying is safe.`,
        `Read-back failed: ${supplyResult.error?.message ?? transactionResult.error?.message}`,
      );
    }
    const supply = supplyResult.data;
    const tx = transactionResult.data;
    if (!supply || !tx) return { ok: false, kind: "missing", problems: [!supply ? "supply entry missing" : "", !tx ? "ledger row missing" : ""].filter(Boolean) };

    const problems: string[] = [];
    if (supply.ingredient_id !== args.p_ingredient_id) problems.push("supply ingredient");
    if (supply.supplier_name !== args.p_supplier_name) problems.push("supplier");
    if (supply.purchase_date !== args.p_purchase_date) problems.push("purchase date");
    if ((supply.brand_name ?? null) !== args.p_brand_name) problems.push("brand");
    if (!sameNumber(supply.pack_quantity, args.p_pack_quantity)) problems.push("pack quantity");
    if (supply.unit !== args.p_display_unit) problems.push("unit");
    if (!sameNumber(supply.total_cost, args.p_total_cost)) problems.push("total cost");
    if ((supply.notes ?? null) !== args.p_notes) problems.push("provenance note");
    if (tx.ingredient_id !== args.p_ingredient_id) problems.push("ledger ingredient");
    if (tx.transaction_type !== "purchase" || tx.source_type !== "manual") problems.push("ledger type/source");
    if (tx.source_id !== supply.id) problems.push("ledger link to the supply entry");
    if (!sameNumber(tx.quantity_change, args.p_base_quantity)) problems.push("ledger quantity change");
    const before = Number(tx.quantity_before);
    const change = Number(tx.quantity_change);
    const after = Number(tx.quantity_after);
    if (![before, change, after].every(Number.isFinite) || !sameNumber(before + change, after)) problems.push("ledger before + change = after");
    if (problems.length > 0) return { ok: false, kind: "mismatch", problems };
    return { ok: true, supplyId: supply.id as string, transactionId: tx.id as string, before, change, after };
  }

  // ---- verify ---------------------------------------------------------------------------------

  async verify(previewId: string): Promise<PurchaseVerified> {
    const artifact = await this.loadArtifact(previewId);
    const preview = artifact.preview;
    try {
      assertPurchasePreviewApproved(preview, preview.approval_code);
    } catch (error) {
      throw integrityFailure(error instanceof Error ? error.message : String(error));
    }
    if (artifact.apply_result === null) {
      throw new PurchaseDomainError("purchase_not_applied", "verification_failed", "No part of this purchase has been applied, so there is nothing to verify.");
    }
    const record = parseApplyRecord(artifact.apply_result, preview);
    const client = await this.authenticatedClient();

    const committed = record.lines.filter(isCommitted);
    if (committed.length === 0) {
      throw new PurchaseDomainError("purchase_not_applied", "verification_failed", "No line of this purchase is recorded as committed, so there is nothing to verify.");
    }

    const ingredientIds = [...new Set(committed.map((line) => line.ingredient_id))];
    const observedResult = await client
      .from("ingredients")
      .select("id,current_quantity,average_unit_cost,cost_reconciled_at")
      .in("id", ingredientIds);
    if (observedResult.error) {
      throw new PurchaseDomainError("purchase_verification_failed", "verification_failed", "The current ingredient state could not be read, so verification could not complete.", observedResult.error.message);
    }
    const observed = new Map((observedResult.data ?? []).map((row) => [row.id as string, row]));

    const rows: PurchaseVerificationRow[] = [];
    for (const line of committed) {
      const readBack = await this.readBackLine(client, preview, line);
      if (!readBack.ok) {
        if (readBack.kind === "missing") {
          throw new PurchaseDomainError(
            "purchase_reversed_or_missing", "verification_failed",
            `Verification FAILED: line ${line.row_number}'s purchase rows are missing. They may have been reversed or deleted. ${NEW_OCCASION}`,
          );
        }
        throw new PurchaseDomainError(
          "purchase_verification_failed", "verification_failed",
          `Verification FAILED: line ${line.row_number}'s purchase rows no longer match the approved purchase (${readBack.problems.join("; ")}).`,
        );
      }
      const row = preview.rows[line.row_number - 1];
      const current = observed.get(line.ingredient_id);
      rows.push({
        row_number: line.row_number,
        ingredient: line.ingredient_name,
        supplier: preview.supplier as string,
        purchase_date: preview.purchase_date as string,
        brand: row.brand,
        entered_quantity: row.entered_quantity as number,
        entered_unit: row.entered_unit as string,
        total_price: row.total_price as number,
        base_unit: row.base_unit as string,
        quantity_before: readBack.before,
        quantity_change: readBack.change,
        quantity_after: readBack.after,
        supply_id: readBack.supplyId,
        transaction_id: readBack.transactionId,
        cost_trusted_at_post: line.cost_trusted,
        current_observed: current
          ? {
            current_quantity: Number(current.current_quantity),
            average_unit_cost: current.average_unit_cost === null || current.average_unit_cost === undefined ? null : Number(current.average_unit_cost),
            cost_reconciled_at: (current.cost_reconciled_at ?? null) as string | null,
          }
          : null,
      });
    }

    const uncommitted = record.lines.filter((line) => !isCommitted(line)).map((line) => line.row_number);
    const complete = uncommitted.length === 0;
    if (complete) await this.artifacts.recordVerified(preview.preview_id, new Date().toISOString());
    return {
      status: complete ? "verified" : "partial",
      preview_id: preview.preview_id,
      occasion_id: preview.occasion_id,
      supplier: preview.supplier as string,
      purchase_date: preview.purchase_date as string,
      apply_status: record.status,
      total_lines: preview.rows.length,
      verified_lines: rows.length,
      uncommitted_rows: uncommitted,
      total_spent: rows.reduce((sum, row) => sum + row.total_price, 0),
      rows,
      note: complete
        ? "Every line's supply entry and ledger row exist and match the approved purchase. Later inventory movements and the current cost state are reported as observed, not compared."
        : `PARTIAL: only ${rows.length} of ${preview.rows.length} lines are committed (not yet posted: ${uncommitted.join(", ")}). The committed lines match, but this purchase is NOT fully applied and is NOT marked verified.`,
    };
  }
}

// ---- view builders ----------------------------------------------------------------------------

function isExpired(artifact: Pick<PurchaseArtifact, "expires_at">): boolean {
  const expires = Date.parse(artifact.expires_at);
  return !Number.isFinite(expires) || expires <= Date.now();
}

function previewView(preview: PurchasePreview, artifact: PurchaseArtifact | null): PurchasePreviewView {
  const applyStatus = artifact?.apply_result && isObject(artifact.apply_result)
    && typeof artifact.apply_result.status === "string" && STATUSES.has(artifact.apply_result.status)
    ? (artifact.apply_result.status as PurchaseApplyStatus)
    : null;
  const alreadyApplied = Boolean(artifact && artifact.apply_result !== null);
  const notice = !preview.can_apply
    ? "BLOCKED. Resolve the errors, then run purchase_preview again. Nothing was written to inventory."
    : alreadyApplied
      ? `This purchase already has apply progress${applyStatus ? ` (${applyStatus})` : ""}. Do not edit it or re-apply it under a changed payload: call purchase_verify, or use a NEW occasion_id for a different purchase.`
      : artifact
        ? `Show this exact preview to the owner and stop. purchase_apply needs a NEW owner message containing the approval code ${preview.approval_code}. Nothing was written to inventory.`
        : "This preview could not be stored (no usable occasion_id) and cannot be applied.";
  return {
    preview_id: preview.preview_id,
    approval_code: preview.approval_code,
    can_apply: preview.can_apply,
    occasion_id: preview.occasion_id,
    supplier: preview.supplier,
    purchase_date: preview.purchase_date,
    source_note: preview.source_note,
    total_price: preview.rows.reduce((sum, row) => sum + (row.total_price ?? 0), 0),
    rows: preview.rows.map((row) => ({
      row_number: row.row_number,
      raw_name: row.raw_name,
      ingredient: row.canonical_ingredient_id && row.canonical_ingredient_name
        ? { id: row.canonical_ingredient_id, name: row.canonical_ingredient_name }
        : null,
      match_status: row.match_status,
      match_type: row.match_type,
      match_candidates: row.match_candidates.map((candidate) => ({
        ingredient_id: candidate.ingredientId,
        ingredient_name: candidate.ingredientName,
        active: candidate.isActive,
        reason: candidate.reason,
      })),
      entered_quantity: row.entered_quantity,
      entered_unit: row.entered_unit,
      converted_quantity: row.converted_quantity,
      base_unit: row.base_unit,
      total_price: row.total_price,
      brand: row.brand,
      evidence: {
        current_quantity: row.current_quantity,
        current_average_unit_cost: row.current_average_unit_cost,
        inventory_reconciled_at: row.current_inventory_reconciled_at,
      },
      errors: row.errors,
    })),
    errors: preview.errors,
    stored: artifact !== null,
    expires_at: artifact?.expires_at ?? null,
    apply_status: applyStatus,
    notice,
  };
}

function appliedView(
  preview: PurchasePreview,
  status: Exclude<PurchaseApplyStatus, "NOT_APPLIED">,
  lines: PurchaseLineResult[],
  failure: PurchaseApplied["failure"],
): PurchaseApplied {
  const committed = lines.filter(isCommitted).length;
  const total = lines.length;
  const retryable = failure && !["purchase_occasion_collision", "purchase_not_authorized"].includes(failure.code);
  const message = status === "PARTIALLY_APPLIED"
    ? `PARTIALLY_APPLIED: ${committed} of ${total} lines are committed in Product Lab and are NOT rolled back. `
      + `Line ${failure?.row_number} failed: ${failure?.message} The lines after it were not attempted. This purchase is not atomic.`
    : status === "REPLAYED"
      ? `All ${total} lines were already committed by an earlier call and still match; nothing was posted by this call.`
      : `All ${total} lines are committed.`;
  const nextStep = status === "PARTIALLY_APPLIED"
    ? retryable
      ? "Report this loudly to the owner. Retrying purchase_apply with the same preview_id and approval_code resumes at the failed line and does not duplicate committed lines. Do not call purchase_verify as if it were complete."
      : "Report this loudly to the owner. Retrying the same preview will keep failing. Do not edit it; use a NEW occasion_id for the remaining lines."
    : "Call purchase_verify with the preview_id before reporting this purchase as verified.";
  return {
    status,
    preview_id: preview.preview_id,
    occasion_id: preview.occasion_id,
    supplier: preview.supplier as string,
    purchase_date: preview.purchase_date as string,
    total_lines: total,
    committed_lines: committed,
    lines: lines.map((line) => lineView(line)),
    failure,
    message,
    next_step: nextStep,
  };
}

// Remote-request variant: one already-authenticated owner client backs the read state, the apply and
// verify reads, the post_raw_purchase calls and the durable artifact store for this single HTTP
// exchange -- the purchase sibling of createInventoryCountServiceForClient.
export function createPurchaseServiceForClient(client: SupabaseClient): PurchaseService {
  return new PurchaseService(
    createProductLabReadServiceForClient(client),
    () => Promise.resolve(client),
    createDurablePurchaseArtifactStore(client),
  );
}
