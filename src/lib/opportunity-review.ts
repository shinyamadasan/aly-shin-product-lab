import { fromOpportunityRow, isOpportunityStatus, type OpportunityRecord, type OpportunityRow, type OpportunityStatus } from "./opportunities.ts";

export const OPPORTUNITY_STATUS_FILTERS = ["new", "all", "accepted", "dismissed", "expired", "converted"] as const;
export type OpportunityStatusFilter = (typeof OPPORTUNITY_STATUS_FILTERS)[number];

export const OPPORTUNITY_STATUS_UPDATE_TARGETS = ["accepted", "dismissed", "expired"] as const;
export type OpportunityStatusUpdateTarget = (typeof OPPORTUNITY_STATUS_UPDATE_TARGETS)[number];

export const OPPORTUNITY_LIST_COLUMNS = [
  "id",
  "opportunity_type",
  "producer",
  "source_type",
  "source_id",
  "title",
  "summary",
  "recommended_action",
  "status",
  "detected_at",
  "expires_at",
  "created_at",
  "updated_at",
].join(",");

export const OPPORTUNITY_LIST_ORDER = [
  { column: "detected_at", ascending: false },
  { column: "created_at", ascending: false },
] as const;

export type OpportunityListRow = Pick<
  Required<OpportunityRow>,
  | "id"
  | "opportunity_type"
  | "producer"
  | "source_type"
  | "source_id"
  | "title"
  | "summary"
  | "recommended_action"
  | "status"
  | "detected_at"
  | "expires_at"
  | "created_at"
  | "updated_at"
>;

export type OpportunityListRecord = {
  id: string;
  opportunityType: string;
  producer: string;
  sourceType: string;
  sourceId: string;
  title: string;
  summary: string;
  recommendedAction: string;
  status: OpportunityStatus;
  detectedAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type OpportunityEvidenceDisplayRow = {
  label: string;
  value: string;
};

export type OpportunityEvidenceSection = {
  title: string;
  rows: OpportunityEvidenceDisplayRow[];
  lines?: string[];
};

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type QueryResult<T> = PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;

type OpportunityQueryBuilder<T> = PromiseLike<{ data: T[] | null; error: SupabaseErrorLike | null }> & {
  eq(column: string, value: string): OpportunityQueryBuilder<T>;
  limit(count: number): OpportunityQueryBuilder<T>;
  order(column: string, options: { ascending: boolean }): OpportunityQueryBuilder<T>;
  maybeSingle(): QueryResult<T>;
  select(columns: string): {
    maybeSingle(): QueryResult<OpportunityRow>;
  };
};

export type OpportunityReviewClient = {
  from(table: "opportunities"): {
    select<T = unknown>(columns: string): OpportunityQueryBuilder<T>;
    update(row: Partial<OpportunityRow>): OpportunityQueryBuilder<OpportunityRow>;
  };
};

export type OpportunityListResult =
  | { ok: true; opportunities: OpportunityListRecord[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

export type OpportunityDetailResult =
  | { ok: true; opportunity: OpportunityRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "failed"; message: string };

export type OpportunityPresenceResult =
  | { ok: true; hasAny: boolean }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

export type OpportunityStatusUpdateResult =
  | { ok: true; opportunity: OpportunityRecord }
  | { ok: false; reason: "invalid-transition" | "conflict" | "not-found" | "missing-table" | "failed"; message: string; currentStatus?: OpportunityStatus };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function dbErrorResult(error: SupabaseErrorLike): { reason: "missing-table" | "failed"; message: string } {
  if (isMissingTableError(error)) {
    return {
      reason: "missing-table",
      message: "Opportunities are not available yet. Verify supabase-add-opportunities.sql has been applied to this Supabase project.",
    };
  }

  return { reason: "failed", message: error.message };
}

function parseOpportunityStatus(value: string): OpportunityStatus {
  return isOpportunityStatus(value) ? value : "new";
}

function normalizeOptional(value: string | null | undefined): string {
  return value ?? "";
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "Unserializable value";
  }
}

function formatEvidenceValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      return value.map((item) => String(item)).join(", ");
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (isRecord(value)) {
    if (isNonEmptyString(value.name) && isNonEmptyString(value.id)) return `${value.name} (${value.id})`;
    if (isNonEmptyString(value.name)) return value.name;
    if (isNonEmptyString(value.id)) return value.id;
    return compactJson(value);
  }
  return String(value);
}

function rowsForRecord(value: unknown, preferredKeys: string[] = []): OpportunityEvidenceDisplayRow[] {
  if (!isRecord(value)) {
    return [{ label: "Value", value: formatEvidenceValue(value) }];
  }

  const keys = [...preferredKeys.filter((key) => Object.hasOwn(value, key)), ...Object.keys(value).filter((key) => !preferredKeys.includes(key)).sort()];
  return keys
    .map((key) => ({ label: humanizeKey(key), value: formatEvidenceValue(value[key]) }))
    .filter((row) => row.value !== "");
}

function sectionFromRecord(title: string, value: unknown, preferredKeys: string[]): OpportunityEvidenceSection | null {
  if (value === undefined) {
    return null;
  }

  return { title, rows: rowsForRecord(value, preferredKeys) };
}

function findingLines(findings: unknown): string[] {
  if (!Array.isArray(findings)) {
    return [];
  }

  return findings.map((finding, index) => {
    if (!isRecord(finding)) {
      return formatEvidenceValue(finding);
    }

    const id = isNonEmptyString(finding.id) ? finding.id : `Finding ${index + 1}`;
    const passed = finding.passed === true ? "passed" : finding.passed === false ? "failed" : "not enough data";
    const message = isNonEmptyString(finding.message) ? finding.message : "No message recorded.";
    const recommendation = isNonEmptyString(finding.recommendation) ? ` Recommendation: ${finding.recommendation}` : "";
    return `${id} (${passed}): ${message}${recommendation}`;
  });
}

export function resolveOpportunityStatusFilter(value: string | string[] | undefined): OpportunityStatusFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && OPPORTUNITY_STATUS_FILTERS.includes(raw as OpportunityStatusFilter) ? (raw as OpportunityStatusFilter) : "new";
}

export function buildOpportunityListQuery(filter: OpportunityStatusFilter): { columns: string; status: OpportunityStatus | null; order: typeof OPPORTUNITY_LIST_ORDER } {
  return {
    columns: OPPORTUNITY_LIST_COLUMNS,
    status: filter === "all" ? null : filter,
    order: OPPORTUNITY_LIST_ORDER,
  };
}

export function fromOpportunityListRow(row: OpportunityListRow): OpportunityListRecord {
  return {
    id: row.id,
    opportunityType: row.opportunity_type,
    producer: row.producer,
    sourceType: row.source_type,
    sourceId: row.source_id,
    title: row.title,
    summary: normalizeOptional(row.summary),
    recommendedAction: row.recommended_action,
    status: parseOpportunityStatus(row.status),
    detectedAt: row.detected_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isOpportunityExpiredByTime(opportunity: Pick<OpportunityListRecord | OpportunityRecord, "status" | "expiresAt">, now: string): boolean {
  const expiresMs = Date.parse(opportunity.expiresAt);
  const nowMs = Date.parse(now);
  return opportunity.status === "new" && Number.isFinite(expiresMs) && Number.isFinite(nowMs) && expiresMs <= nowMs;
}

export function getOpportunityActionAvailability(opportunity: Pick<OpportunityListRecord | OpportunityRecord, "status" | "expiresAt">, now: string) {
  const isNew = opportunity.status === "new";
  const expiredByTime = isOpportunityExpiredByTime(opportunity, now);
  return {
    expiredByTime,
    canAccept: isNew,
    canDismiss: isNew,
    canMarkExpired: isNew && expiredByTime,
    readOnly: !isNew,
  };
}

export function buildOpportunityEvidenceSections(evidence: unknown, sourceFindings: unknown[] = []): OpportunityEvidenceSection[] {
  if (!isRecord(evidence)) {
    return [{ title: "Evidence snapshot", rows: [{ label: "Value", value: formatEvidenceValue(evidence) }] }];
  }

  const sections = [
    sectionFromRecord("Briefing or source artifact", evidence.briefing, ["date", "timezone", "dataSource", "markdownPath", "artifactBranch"]),
    sectionFromRecord("Producer", evidence.producer, ["name", "version"]),
    sectionFromRecord("Product", evidence.product, ["id", "name", "category", "role", "status", "decision"]),
    sectionFromRecord("Latest batch", evidence.latestBatch, ["id", "batchVersion", "dateMade", "usablePieces", "imperfectPieces", "launchDecision"]),
    sectionFromRecord("Linked costing", evidence.linkedCosting, ["id", "batchId", "productId", "ingredientCost", "packagingCost", "laborEstimate", "wasteAllowance", "overheadCost", "equipmentCost", "suggestedPrice"]),
    sectionFromRecord("Costing metrics", evidence.costingMetrics, []),
    sectionFromRecord("Tasting signal", evidence.tastingSignal, ["productTastingCount", "productAverageRating", "latestBatchTastingCount"]),
    sectionFromRecord("Rule Engine summary", evidence.ruleEngine, ["productHealth", "readinessPercentage", "noActiveBlockersOrWarnings"]),
  ].filter((section): section is OpportunityEvidenceSection => Boolean(section));

  const copiedFindings = sourceFindings.length > 0 ? sourceFindings : Array.isArray(evidence.qualifyingRuleResults) ? evidence.qualifyingRuleResults : [];
  const lines = findingLines(copiedFindings);
  if (lines.length > 0) {
    sections.push({ title: "Copied Rule Results or findings", rows: [], lines });
  }

  if (sections.length === 0) {
    sections.push({ title: "Evidence snapshot", rows: rowsForRecord(evidence) });
  }

  return sections;
}

export function formatOpportunityRawJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unable to serialize evidence.";
  }
}

export async function listOpportunities(client: OpportunityReviewClient, filter: OpportunityStatusFilter): Promise<OpportunityListResult> {
  const spec = buildOpportunityListQuery(filter);
  let query = client.from("opportunities").select<OpportunityListRow>(spec.columns);
  if (spec.status) {
    query = query.eq("status", spec.status);
  }
  for (const order of spec.order) {
    query = query.order(order.column, { ascending: order.ascending });
  }

  const result = await query;
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  return { ok: true, opportunities: (result.data ?? []).map(fromOpportunityListRow) };
}

export type OpportunitySelectionResult =
  | { ok: true; opportunity: OpportunityListRecord | null }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

function moreRecentOpportunityCandidate(a: OpportunityListRecord | null, b: OpportunityListRecord | null): OpportunityListRecord | null {
  if (!a) return b;
  if (!b) return a;
  const aDetected = Date.parse(a.detectedAt);
  const bDetected = Date.parse(b.detectedAt);
  if (aDetected !== bDetected) {
    return aDetected > bDetected ? a : b;
  }
  const aCreated = Date.parse(a.createdAt);
  const bCreated = Date.parse(b.createdAt);
  return aCreated >= bCreated ? a : b;
}

// The preparation script's selection contract: the newest Opportunity that still needs advancing
// toward a ready Creative Package. Eligible statuses are "new" and "accepted" only -- an
// Opportunity remains the selected candidate across its own new -> accepted transition, because
// neither underlying call is affected by that transition, only by which list the row currently
// sorts into. Terminal statuses (dismissed/expired/converted) are never eligible.
//
// Deliberately a *different* question from "what is safe to show right now" -- see
// selectTodaysReadyOpportunity in todays-recommendation.ts for that one. Collapsing the two into
// a single selector is what creates a timing race between the overnight preparation run and
// whenever the owner happens to open the app.
export async function selectPreparationCandidate(client: OpportunityReviewClient): Promise<OpportunitySelectionResult> {
  const [newResult, acceptedResult] = await Promise.all([listOpportunities(client, "new"), listOpportunities(client, "accepted")]);

  if (!newResult.ok) {
    return { ok: false, reason: newResult.reason, message: newResult.message };
  }
  if (!acceptedResult.ok) {
    return { ok: false, reason: acceptedResult.reason, message: acceptedResult.message };
  }

  const newestNew = newResult.opportunities[0] ?? null;
  const newestAccepted = acceptedResult.opportunities[0] ?? null;
  return { ok: true, opportunity: moreRecentOpportunityCandidate(newestNew, newestAccepted) };
}

export async function hasAnyOpportunities(client: OpportunityReviewClient): Promise<OpportunityPresenceResult> {
  const result = await client.from("opportunities").select<{ id: string }>("id").limit(1);
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  return { ok: true, hasAny: (result.data ?? []).length > 0 };
}

export async function getOpportunityDetail(client: OpportunityReviewClient, id: string): Promise<OpportunityDetailResult> {
  const result = await client.from("opportunities").select<OpportunityRow>("*").eq("id", id).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false, reason: "not-found", message: "Opportunity not found. It may have been removed or filtered out by access rules." };
  }

  try {
    return { ok: true, opportunity: fromOpportunityRow(result.data) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

function isTargetLocallyAllowed(opportunity: OpportunityRecord, target: OpportunityStatusUpdateTarget, now: string): boolean {
  const availability = getOpportunityActionAvailability(opportunity, now);
  if (target === "accepted") return availability.canAccept;
  if (target === "dismissed") return availability.canDismiss;
  return availability.canMarkExpired;
}

export async function updateOpportunityStatus(
  client: OpportunityReviewClient,
  id: string,
  target: OpportunityStatusUpdateTarget,
  options: { now?: () => string } = {},
): Promise<OpportunityStatusUpdateResult> {
  const now = options.now?.() ?? new Date().toISOString();
  const before = await getOpportunityDetail(client, id);
  if (!before.ok) {
    return before.reason === "not-found"
      ? { ok: false, reason: "not-found", message: before.message }
      : { ok: false, reason: before.reason, message: before.message };
  }

  if (!isTargetLocallyAllowed(before.opportunity, target, now)) {
    return {
      ok: false,
      reason: "invalid-transition",
      message: before.opportunity.status === "new" ? "This action is not available for the current Opportunity state." : `This Opportunity is already ${before.opportunity.status} and is read-only.`,
      currentStatus: before.opportunity.status,
    };
  }

  const result = await client.from("opportunities").update({ status: target, updated_at: now }).eq("id", id).eq("status", "new").select("*").maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (result.data) {
    try {
      return { ok: true, opportunity: fromOpportunityRow(result.data) };
    } catch (err) {
      return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  const reread = await getOpportunityDetail(client, id);
  if (!reread.ok) {
    return reread.reason === "not-found"
      ? { ok: false, reason: "not-found", message: "Opportunity was not updated because it could not be found after the conditional update." }
      : { ok: false, reason: reread.reason, message: reread.message };
  }

  return {
    ok: false,
    reason: "conflict",
    message: reread.opportunity.status === "new"
      ? "Opportunity was not updated because the conditional update affected no rows. Refresh and try again."
      : `Opportunity was already changed to ${reread.opportunity.status}. No status was overwritten.`,
    currentStatus: reread.opportunity.status,
  };
}
