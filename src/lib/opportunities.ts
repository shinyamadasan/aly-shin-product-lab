export const OPPORTUNITY_STATUSES = ["new", "accepted", "dismissed", "expired", "converted"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export type OpportunityRecommendedAction = "create_content";
export type OpportunitySourceType = "daily_advisor";
export type OpportunityExpirationPolicy = "fresh_batch_same_day_availability" | "general_product_promotion" | "expiry_related";

export type OpportunityEvidence = Record<string, unknown>;

export type OpportunitySourceFinding = {
  id: string;
  category: string;
  severity: string;
  passed: boolean | null;
  message: string;
  recommendation: string;
};

export type OpportunityDraft = {
  opportunityType: string;
  producer: string;
  sourceType: OpportunitySourceType;
  sourceId: string;
  title: string;
  summary?: string;
  reason: string;
  recommendedAction: OpportunityRecommendedAction;
  evidenceVersion: string;
  evidence: OpportunityEvidence;
  sourceRuleIds: string[];
  sourceFindings: OpportunitySourceFinding[];
  detectedAt: string;
  expiresAt: string;
  deduplicationKey: string;
  status?: OpportunityStatus;
};

export type OpportunityRecord = Omit<Required<OpportunityDraft>, "status"> & {
  id: string;
  summary: string;
  status: OpportunityStatus;
  createdAt: string;
  updatedAt: string;
};

export type OpportunityRow = {
  id?: string;
  opportunity_type: string;
  producer: string;
  source_type: OpportunitySourceType;
  source_id: string;
  title: string;
  summary: string | null;
  reason: string;
  recommended_action: OpportunityRecommendedAction;
  evidence_version: string;
  evidence: OpportunityEvidence;
  source_rule_ids: string[];
  source_findings: OpportunitySourceFinding[];
  status: OpportunityStatus;
  detected_at: string;
  expires_at: string;
  deduplication_key: string;
  created_at?: string;
  updated_at?: string;
};

export type OpportunityValidationResult =
  | { ok: true; value: Required<OpportunityDraft> }
  | { ok: false; errors: string[] };

const RECOMMENDED_ACTIONS: readonly OpportunityRecommendedAction[] = ["create_content"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isJsonObject(value: unknown): value is OpportunityEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeStablePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function requireNormalized(label: string, value: string): string {
  const normalized = normalizeStablePart(value);
  if (!normalized) {
    throw new Error(`${label} is required for Opportunity deduplication.`);
  }
  return normalized;
}

export function isOpportunityStatus(value: string): value is OpportunityStatus {
  return OPPORTUNITY_STATUSES.includes(value as OpportunityStatus);
}

export function validateOpportunityDraft(draft: OpportunityDraft): OpportunityValidationResult {
  const errors: string[] = [];
  const status = draft.status ?? "new";

  for (const [field, value] of [
    ["opportunityType", draft.opportunityType],
    ["producer", draft.producer],
    ["sourceType", draft.sourceType],
    ["sourceId", draft.sourceId],
    ["title", draft.title],
    ["reason", draft.reason],
    ["evidenceVersion", draft.evidenceVersion],
    ["deduplicationKey", draft.deduplicationKey],
  ] as const) {
    if (!isNonEmptyString(value)) {
      errors.push(`${field} is required.`);
    }
  }

  if (!RECOMMENDED_ACTIONS.includes(draft.recommendedAction)) {
    errors.push("recommendedAction must be create_content.");
  }
  if (!isOpportunityStatus(status)) {
    errors.push("status is not an approved Opportunity status.");
  }
  if (!isValidTimestamp(draft.detectedAt)) {
    errors.push("detectedAt must be a valid timestamp.");
  }
  if (!isValidTimestamp(draft.expiresAt)) {
    errors.push("expiresAt must be a valid timestamp.");
  }
  if (isValidTimestamp(draft.detectedAt) && isValidTimestamp(draft.expiresAt) && Date.parse(draft.expiresAt) <= Date.parse(draft.detectedAt)) {
    errors.push("expiresAt must be after detectedAt.");
  }
  if (!isJsonObject(draft.evidence)) {
    errors.push("evidence must be a non-null JSON object.");
  }
  if (!Array.isArray(draft.sourceRuleIds) || draft.sourceRuleIds.length === 0 || draft.sourceRuleIds.some((id) => !isNonEmptyString(id))) {
    errors.push("sourceRuleIds must contain at least one stable rule ID.");
  }
  if (
    !Array.isArray(draft.sourceFindings) ||
    draft.sourceFindings.some((finding) => !isNonEmptyString(finding.id) || !isNonEmptyString(finding.message) || !isNonEmptyString(finding.recommendation))
  ) {
    errors.push("sourceFindings must preserve rule IDs, messages, and recommendations.");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      ...draft,
      opportunityType: draft.opportunityType.trim(),
      producer: draft.producer.trim(),
      sourceId: draft.sourceId.trim(),
      title: draft.title.trim(),
      summary: draft.summary?.trim() ?? "",
      reason: draft.reason.trim(),
      evidenceVersion: draft.evidenceVersion.trim(),
      deduplicationKey: draft.deduplicationKey.trim(),
      status,
    },
  };
}

export function buildOpportunityDeduplicationKey(input: {
  producer: string;
  findingType: string;
  entityIds: Record<string, string>;
  action: OpportunityRecommendedAction;
  businessDate: string;
}): string {
  const producer = requireNormalized("producer", input.producer);
  const findingType = requireNormalized("findingType", input.findingType);
  const action = requireNormalized("action", input.action);
  const businessDate = input.businessDate.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error("businessDate must be YYYY-MM-DD for Opportunity deduplication.");
  }

  const entityParts = Object.entries(input.entityIds)
    .map(([key, value]) => [requireNormalized("entity key", key), requireNormalized(`entity ${key}`, value)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `entity:${key}=${value}`);

  if (entityParts.length === 0) {
    throw new Error("at least one entity ID is required for Opportunity deduplication.");
  }

  return [`v1`, `producer=${producer}`, `finding_type=${findingType}`, ...entityParts, `action=${action}`, `business_date=${businessDate}`].join("|");
}

export function calculateOpportunityExpiresAt(input: { detectedAt: string; policy: OpportunityExpirationPolicy; relevantExpiryDate?: string }): string {
  if (!isValidTimestamp(input.detectedAt)) {
    throw new Error("detectedAt must be a valid timestamp.");
  }

  const detectedMs = Date.parse(input.detectedAt);
  if (input.policy === "fresh_batch_same_day_availability") {
    return new Date(detectedMs + 24 * 60 * 60 * 1000).toISOString();
  }
  if (input.policy === "general_product_promotion") {
    return new Date(detectedMs + 72 * 60 * 60 * 1000).toISOString();
  }

  const expiry = input.relevantExpiryDate?.trim();
  if (!expiry) {
    throw new Error("relevantExpiryDate is required for expiry-related Opportunities.");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return new Date(`${expiry}T23:59:59.999Z`).toISOString();
  }
  if (!isValidTimestamp(expiry)) {
    throw new Error("relevantExpiryDate must be a valid date or timestamp.");
  }
  return new Date(expiry).toISOString();
}

export function toOpportunityRow(draft: OpportunityDraft): OpportunityRow {
  const validation = validateOpportunityDraft(draft);
  if (!validation.ok) {
    throw new Error(`Invalid Opportunity draft: ${validation.errors.join(" ")}`);
  }

  const value = validation.value;
  return {
    opportunity_type: value.opportunityType,
    producer: value.producer,
    source_type: value.sourceType,
    source_id: value.sourceId,
    title: value.title,
    summary: value.summary || null,
    reason: value.reason,
    recommended_action: value.recommendedAction,
    evidence_version: value.evidenceVersion,
    evidence: value.evidence,
    source_rule_ids: value.sourceRuleIds,
    source_findings: value.sourceFindings,
    status: value.status,
    detected_at: new Date(value.detectedAt).toISOString(),
    expires_at: new Date(value.expiresAt).toISOString(),
    deduplication_key: value.deduplicationKey,
  };
}

export function fromOpportunityRow(row: OpportunityRow): OpportunityRecord {
  if (!row.id || !row.created_at || !row.updated_at) {
    throw new Error("Opportunity row is missing id, created_at, or updated_at.");
  }

  return {
    id: row.id,
    opportunityType: row.opportunity_type,
    producer: row.producer,
    sourceType: row.source_type,
    sourceId: row.source_id,
    title: row.title,
    summary: row.summary ?? "",
    reason: row.reason,
    recommendedAction: row.recommended_action,
    evidenceVersion: row.evidence_version,
    evidence: row.evidence,
    sourceRuleIds: row.source_rule_ids,
    sourceFindings: row.source_findings,
    detectedAt: row.detected_at,
    expiresAt: row.expires_at,
    deduplicationKey: row.deduplication_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
