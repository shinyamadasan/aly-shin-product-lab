import { toOpportunityRow, type OpportunityDraft, type OpportunityRow, type OpportunityStatus } from "../../src/lib/opportunities.ts";

type SupabaseErrorLike = {
  code?: string;
  message: string;
  details?: string;
  hint?: string;
};

type QueryResult<T> = PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;

type ConditionalUpdateBuilder = {
  eq(column: string, value: string): ConditionalUpdateBuilder;
  select(columns: string): {
    maybeSingle(): QueryResult<OpportunityRow>;
  };
};

export type OpportunityPersistenceClient = {
  from(table: "opportunities"): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): QueryResult<OpportunityRow>;
      };
    };
    insert(row: OpportunityRow): {
      select(columns: string): {
        single(): QueryResult<OpportunityRow>;
      };
    };
    update(row: Partial<OpportunityRow>): ConditionalUpdateBuilder;
  };
};

export type PersistOpportunityOutcome = "inserted" | "updated" | "skipped" | "failed";

export type PersistOpportunityDetail = {
  deduplicationKey: string;
  outcome: PersistOpportunityOutcome;
  reason?: string;
  status?: OpportunityStatus;
};

export type PersistOpportunitiesResult = {
  ok: boolean;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  details: PersistOpportunityDetail[];
};

const TERMINAL_STATUSES = new Set<OpportunityStatus>(["accepted", "dismissed", "expired", "converted"]);

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /relation .*opportunities.* does not exist/i.test(error.message) ||
    /could not find .*opportunities/i.test(error.message) ||
    /schema cache.*opportunities/i.test(error.message)
  );
}

function isUniqueViolationError(error: SupabaseErrorLike): boolean {
  return error.code === "23505" || /duplicate key value violates unique constraint/i.test(error.message);
}

function failure(deduplicationKey: string, reason: string): PersistOpportunityDetail {
  return { deduplicationKey, outcome: "failed", reason };
}

function rowErrorReason(action: string, error: SupabaseErrorLike): string {
  if (isMissingTableError(error)) {
    return "missing-table";
  }
  return `${action}: ${error.message}`;
}

function mutableUpdateRow(draft: OpportunityDraft, updatedAt: string): Partial<OpportunityRow> {
  const row = toOpportunityRow(draft);
  return {
    opportunity_type: row.opportunity_type,
    producer: row.producer,
    source_type: row.source_type,
    source_id: row.source_id,
    title: row.title,
    summary: row.summary,
    reason: row.reason,
    recommended_action: row.recommended_action,
    evidence_version: row.evidence_version,
    evidence: row.evidence,
    source_rule_ids: row.source_rule_ids,
    source_findings: row.source_findings,
    expires_at: row.expires_at,
    deduplication_key: row.deduplication_key,
    updated_at: updatedAt,
  };
}

async function readExisting(client: OpportunityPersistenceClient, deduplicationKey: string) {
  return client.from("opportunities").select("*").eq("deduplication_key", deduplicationKey).maybeSingle();
}

async function updateExisting(client: OpportunityPersistenceClient, draft: OpportunityDraft, existing: OpportunityRow, updatedAt: string): Promise<PersistOpportunityDetail> {
  if (!existing.id) {
    return failure(draft.deduplicationKey, "existing-row-missing-id");
  }

  const result = await client.from("opportunities").update(mutableUpdateRow(draft, updatedAt)).eq("id", existing.id).eq("status", "new").select("*").maybeSingle();
  if (result.error) {
    return failure(draft.deduplicationKey, rowErrorReason("update failed", result.error));
  }
  if (result.data) {
    return { deduplicationKey: draft.deduplicationKey, outcome: "updated", status: result.data.status };
  }

  const reread = await readExisting(client, draft.deduplicationKey);
  if (reread.error) {
    return failure(draft.deduplicationKey, rowErrorReason("conditional update reread failed", reread.error));
  }
  if (reread.data) {
    if (TERMINAL_STATUSES.has(reread.data.status)) {
      return {
        deduplicationKey: draft.deduplicationKey,
        outcome: "skipped",
        reason: `existing-${reread.data.status}`,
        status: reread.data.status,
      };
    }
    if (reread.data.status === "new") {
      return failure(draft.deduplicationKey, "conditional-update-conflict-still-new");
    }
    return failure(draft.deduplicationKey, `unsupported-existing-status-${reread.data.status}`);
  }

  return failure(draft.deduplicationKey, "conditional-update-conflict-missing-row");
}

async function persistOne(client: OpportunityPersistenceClient, draft: OpportunityDraft, updatedAt: string, retryAfterUniqueViolation = true): Promise<PersistOpportunityDetail> {
  let row: OpportunityRow;
  try {
    row = toOpportunityRow(draft);
  } catch (err) {
    return failure(draft.deduplicationKey, err instanceof Error ? err.message : String(err));
  }

  const existing = await readExisting(client, row.deduplication_key);
  if (existing.error) {
    return failure(row.deduplication_key, rowErrorReason("lookup failed", existing.error));
  }

  if (existing.data) {
    if (existing.data.status === "new") {
      return updateExisting(client, draft, existing.data, updatedAt);
    }
    if (TERMINAL_STATUSES.has(existing.data.status)) {
      return {
        deduplicationKey: row.deduplication_key,
        outcome: "skipped",
        reason: `existing-${existing.data.status}`,
        status: existing.data.status,
      };
    }
    return failure(row.deduplication_key, `unsupported-existing-status-${existing.data.status}`);
  }

  const inserted = await client.from("opportunities").insert(row).select("*").single();
  if (!inserted.error) {
    return { deduplicationKey: row.deduplication_key, outcome: "inserted", status: inserted.data?.status ?? "new" };
  }

  if (retryAfterUniqueViolation && isUniqueViolationError(inserted.error)) {
    return persistOne(client, draft, updatedAt, false);
  }

  return failure(row.deduplication_key, rowErrorReason("insert failed", inserted.error));
}

export async function persistOpportunityDrafts(client: OpportunityPersistenceClient, drafts: OpportunityDraft[], options: { now?: () => string } = {}): Promise<PersistOpportunitiesResult> {
  const updatedAt = options.now?.() ?? new Date().toISOString();
  const details: PersistOpportunityDetail[] = [];

  for (const draft of drafts) {
    try {
      details.push(await persistOne(client, draft, updatedAt));
    } catch (err) {
      details.push(failure(draft.deduplicationKey, err instanceof Error ? err.message : String(err)));
    }
  }

  const inserted = details.filter((detail) => detail.outcome === "inserted").length;
  const updated = details.filter((detail) => detail.outcome === "updated").length;
  const skipped = details.filter((detail) => detail.outcome === "skipped").length;
  const failed = details.filter((detail) => detail.outcome === "failed").length;

  return { ok: failed === 0, inserted, updated, skipped, failed, details };
}
