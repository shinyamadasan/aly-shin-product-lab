"use client";

import { BriefcaseBusiness, CheckCircle2, Clock3, Eye, PackageCheck, XCircle } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MessageBox, Panel, Tag } from "@/components/ui";
import {
  createCreativeJobForAcceptedOpportunity,
  getCreativeJobForOpportunity,
  getCreativeJobStatusLabel,
  isCreativeJobResultEnvelope,
  isCreativeJobTerminal,
  type CreativeJobClient,
  type CreativeJobRecord,
} from "@/lib/creative-jobs";
import {
  getCreativePackageForJob,
  isCreativePackageContentV1,
  type CreativePackageClient,
  type CreativePackageRecord,
} from "@/lib/creative-packages";
import {
  buildOpportunityEvidenceSections,
  formatOpportunityRawJson,
  getOpportunityActionAvailability,
  getOpportunityDetail,
  hasAnyOpportunities,
  isOpportunityExpiredByTime,
  listOpportunities,
  updateOpportunityStatus,
  type OpportunityListRecord,
  type OpportunityReviewClient,
  type OpportunityStatusFilter,
  type OpportunityStatusUpdateTarget,
} from "@/lib/opportunity-review";
import type { OpportunityRecord, OpportunityStatus } from "@/lib/opportunities";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

const filterOptions: Array<{ value: OpportunityStatusFilter; label: string }> = [
  { value: "new", label: "New" },
  { value: "all", label: "All" },
  { value: "accepted", label: "Accepted" },
  { value: "dismissed", label: "Dismissed" },
  { value: "expired", label: "Expired" },
  { value: "converted", label: "Converted" },
];

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || "Unknown" : date.toLocaleString();
}

function displayCode(value: string): string {
  return value.replace(/_/g, " ");
}

function statusTone(status: OpportunityStatus): "warm" | "green" | "danger" {
  if (status === "accepted" || status === "converted") return "green";
  if (status === "dismissed" || status === "expired") return "danger";
  return "warm";
}

function statusLabel(status: OpportunityStatus): string {
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

function creativeJobStatusTone(status: CreativeJobRecord["status"]): "warm" | "green" | "danger" {
  if (status === "completed") return "green";
  if (status === "failed") return "danger";
  return "warm";
}

function filterLabel(filter: OpportunityStatusFilter): string {
  return filterOptions.find((option) => option.value === filter)?.label ?? "New";
}

function metadataBlock(label: string, value: string) {
  return (
    <div className="text-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{label}</p>
      <p className="mt-1 break-words font-semibold">{value || "Not recorded"}</p>
    </div>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
  tone = "neutral",
}: {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
  tone?: "neutral" | "positive" | "danger";
}) {
  const colors =
    tone === "positive"
      ? "border-[#7aa789] bg-[#e9f3ed] text-[#2e6b44]"
      : tone === "danger"
        ? "border-[#e2a09a] bg-[#fff5f2] text-[#8a3827]"
        : "border-[#d8c7b7] bg-white text-[#5f4a3d]";

  return (
    <button className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${colors}`} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
}

export function OpportunitiesPage({ initialStatusFilter }: { initialStatusFilter: OpportunityStatusFilter }) {
  const [filter, setFilter] = useState<OpportunityStatusFilter>(initialStatusFilter);
  const [rows, setRows] = useState<OpportunityListRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedOpportunity, setSelectedOpportunity] = useState<OpportunityRecord | null>(null);
  const [selectedJob, setSelectedJob] = useState<CreativeJobRecord | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<CreativePackageRecord | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [jobError, setJobError] = useState("");
  const [packageError, setPackageError] = useState("");
  const [hasAny, setHasAny] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"good" | "bad" | "info">("info");
  const [pendingAction, setPendingAction] = useState<OpportunityStatusUpdateTarget | null>(null);
  const [isCreatingJob, setIsCreatingJob] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [now, setNow] = useState(() => new Date().toISOString());

  const client = supabase as unknown as OpportunityReviewClient | null;
  const creativeJobClient = supabase as unknown as CreativeJobClient | null;
  const creativePackageClient = supabase as unknown as CreativePackageClient | null;

  useEffect(() => {
    let cancelled = false;

    async function loadList() {
      setNow(new Date().toISOString());
      setListError("");
      setIsLoadingList(true);

      if (!isSupabaseConfigured || !client) {
        if (!cancelled) {
          setRows([]);
          setHasAny(false);
          setListError("Opportunities require the configured Supabase project. Local browser-only mode cannot read the shared review queue.");
          setIsLoadingList(false);
        }
        return;
      }

      const result = await listOpportunities(client, filter);
      if (cancelled) return;

      if (!result.ok) {
        setRows([]);
        setSelectedId(null);
        setSelectedOpportunity(null);
        setSelectedJob(null);
        setSelectedPackage(null);
        setListError(result.message);
        setIsLoadingList(false);
        return;
      }

      setRows(result.opportunities);
      setSelectedId((current) => (current && result.opportunities.some((item) => item.id === current) ? current : result.opportunities[0]?.id ?? null));
      if (filter === "all" || result.opportunities.length > 0) {
        setHasAny(result.opportunities.length > 0);
      } else {
        const presence = await hasAnyOpportunities(client);
        if (!cancelled) {
          setHasAny(presence.ok ? presence.hasAny : null);
        }
      }
      setIsLoadingList(false);
    }

    loadList();
    return () => {
      cancelled = true;
    };
  }, [client, filter, refreshToken]);

  useEffect(() => {
    let cancelled = false;

    async function loadDetail() {
      setDetailError("");
      setJobError("");
      setPackageError("");
      if (!selectedId || !client) {
        setSelectedOpportunity(null);
        setSelectedJob(null);
        setSelectedPackage(null);
        return;
      }

      setIsLoadingDetail(true);
      const result = await getOpportunityDetail(client, selectedId);
      if (cancelled) return;

      if (result.ok) {
        setSelectedOpportunity(result.opportunity);
        if (creativeJobClient) {
          const jobResult = await getCreativeJobForOpportunity(creativeJobClient, result.opportunity.id);
          if (cancelled) return;
          if (jobResult.ok) {
            setSelectedJob(jobResult.job);
            if (jobResult.job.status === "completed" && creativePackageClient) {
              const packageResult = await getCreativePackageForJob(creativePackageClient, jobResult.job.id);
              if (cancelled) return;
              if (packageResult.ok) {
                setSelectedPackage(packageResult.creativePackage);
              } else {
                setSelectedPackage(null);
                if (packageResult.reason !== "not-found") {
                  setPackageError(packageResult.message);
                }
              }
            } else {
              setSelectedPackage(null);
            }
          } else {
            setSelectedJob(null);
            setSelectedPackage(null);
            if (jobResult.reason !== "not-found") {
              setJobError(jobResult.message);
            }
          }
        } else {
          setSelectedJob(null);
          setSelectedPackage(null);
        }
      } else {
        setSelectedOpportunity(null);
        setSelectedJob(null);
        setSelectedPackage(null);
        setDetailError(result.message);
      }
      setIsLoadingDetail(false);
    }

    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [client, creativeJobClient, creativePackageClient, selectedId, refreshToken]);

  const selectedSummary = useMemo(() => rows.find((item) => item.id === selectedId) ?? null, [rows, selectedId]);
  const activeOpportunity = selectedOpportunity ?? selectedSummary;
  const actions = activeOpportunity ? getOpportunityActionAvailability(activeOpportunity, now) : null;
  const evidenceSections = selectedOpportunity ? buildOpportunityEvidenceSections(selectedOpportunity.evidence, selectedOpportunity.sourceFindings) : [];
  const rawEvidence = selectedOpportunity ? formatOpportunityRawJson(selectedOpportunity.evidence) : "";

  async function applyStatus(target: OpportunityStatusUpdateTarget) {
    if (!selectedOpportunity || !client) {
      return;
    }

    setPendingAction(target);
    setMessage("");
    const result = await updateOpportunityStatus(client, selectedOpportunity.id, target, { now: () => new Date().toISOString() });
    if (result.ok) {
      setSelectedOpportunity(result.opportunity);
      setSelectedJob(null);
      setSelectedPackage(null);
      setMessage(`Opportunity marked ${result.opportunity.status}.`);
      setMessageTone("good");
      setRefreshToken((current) => current + 1);
    } else {
      setMessage(result.message);
      setMessageTone(result.reason === "conflict" ? "info" : "bad");
      setRefreshToken((current) => current + 1);
    }
    setPendingAction(null);
  }

  async function createJob() {
    if (!selectedOpportunity || !creativeJobClient) {
      return;
    }

    setIsCreatingJob(true);
    setMessage("");
    setJobError("");

    const created = await createCreativeJobForAcceptedOpportunity(creativeJobClient, selectedOpportunity.id);
    if (!created.ok) {
      setMessage(created.message);
      setMessageTone(created.reason === "not-accepted" ? "info" : "bad");
      setIsCreatingJob(false);
      setRefreshToken((current) => current + 1);
      return;
    }

    setSelectedJob(created.job);
    setSelectedPackage(null);
    setMessage(created.outcome === "created" ? "Creative Job queued." : "Creative Job already exists.");
    setMessageTone("good");
    setIsCreatingJob(false);
    setRefreshToken((current) => current + 1);
  }

  function emptyMessage() {
    if (filter === "all" || hasAny === false) {
      return "No Opportunities exist yet. Daily Advisor will add them when a product has complete qualifying evidence.";
    }
    if (hasAny === true) {
      return `No Opportunities match the ${filterLabel(filter)} filter.`;
    }
    return "No Opportunities match this filter.";
  }

  return (
    <section className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-5">
        {message ? <MessageBox message={message} tone={messageTone} /> : null}

        <div className="rounded-lg border border-[#e1d4c4] bg-white">
          <div className="flex flex-col gap-4 border-b border-[#eaded2] p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Review queue</p>
              <h3 className="mt-1 text-xl font-semibold">Opportunities</h3>
              <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">Review business-backed Opportunities from Product Lab before any later content work begins.</p>
            </div>
            <nav aria-label="Opportunity status filters" className="flex flex-wrap gap-2">
              {filterOptions.map((option) => {
                const active = option.value === filter;
                return (
                  <a
                    aria-current={active ? "page" : undefined}
                    className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                      active ? "border-[#231813] bg-[#231813] text-white" : "border-[#d8c7b7] bg-white text-[#5f4a3d]"
                    }`}
                    href={`/opportunities?status=${option.value}`}
                    key={option.value}
                    onClick={() => {
                      setMessage("");
                      setFilter(option.value);
                    }}
                  >
                    {option.label}
                    {active ? " (selected)" : ""}
                  </a>
                );
              })}
            </nav>
          </div>

          {listError ? <MessageBox message={listError} tone="bad" /> : null}
          {isLoadingList ? <p className="p-5 text-sm text-[#6f5a4c]">Loading Opportunities...</p> : null}
          {!isLoadingList && !listError && rows.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">{emptyMessage()}</p> : null}
          {!isLoadingList && rows.length > 0 ? (
            <div className="divide-y divide-[#f0e4d8]">
              {rows.map((opportunity) => {
                const selected = opportunity.id === selectedId;
                const expiredByTime = isOpportunityExpiredByTime(opportunity, now);
                return (
                  <article className={`grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_150px_150px_160px_110px] ${selected ? "bg-[#fffaf3]" : ""}`} key={opportunity.id}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Tag tone={statusTone(opportunity.status)}>Status: {statusLabel(opportunity.status)}</Tag>
                        {expiredByTime ? <Tag tone="danger">Expired by time</Tag> : null}
                      </div>
                      <h4 className="mt-2 font-semibold">{opportunity.title}</h4>
                      {opportunity.summary ? <p className="mt-1 text-sm leading-6 text-[#6f5a4c]">{opportunity.summary}</p> : null}
                      <p className="mt-2 break-words text-xs text-[#8a7465]">Source: {opportunity.sourceType} / {opportunity.sourceId}</p>
                    </div>
                    {metadataBlock("Type", displayCode(opportunity.opportunityType))}
                    {metadataBlock("Producer", displayCode(opportunity.producer))}
                    {metadataBlock("Action", displayCode(opportunity.recommendedAction))}
                    <div className="flex flex-col gap-2 text-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Dates</p>
                      <p className="font-semibold">Detected {formatDateTime(opportunity.detectedAt)}</p>
                      <p className="text-[#6f5a4c]">Expires {formatDateTime(opportunity.expiresAt)}</p>
                      <button
                        className={`mt-1 inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm font-semibold ${
                          selected ? "border-[#231813] bg-[#231813] text-white" : "border-[#d8c7b7] bg-white text-[#5f4a3d]"
                        }`}
                        onClick={() => setSelectedId(opportunity.id)}
                        type="button"
                      >
                        <Eye size={15} />
                        View details
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      <Panel title="Opportunity Detail" icon={<Clock3 size={18} />}>
        {!selectedId && !isLoadingDetail ? <p className="text-sm leading-6 text-[#6f5a4c]">Select an Opportunity to inspect the evidence snapshot.</p> : null}
        {isLoadingDetail ? <p className="text-sm leading-6 text-[#6f5a4c]">Loading detail...</p> : null}
        {detailError ? <MessageBox message={detailError} tone="bad" /> : null}
        {selectedOpportunity ? (
          <div className="space-y-5 text-sm leading-6 text-[#5f4a3d]">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={statusTone(selectedOpportunity.status)}>Status: {statusLabel(selectedOpportunity.status)}</Tag>
                {actions?.expiredByTime ? <Tag tone="danger">Expired by time</Tag> : null}
              </div>
              <h3 className="mt-2 text-lg font-semibold text-[#211713]">{selectedOpportunity.title}</h3>
              <p className="mt-2">{selectedOpportunity.reason || selectedOpportunity.summary || "No business reason recorded."}</p>
            </div>

            {selectedOpportunity.status === "new" ? (
              <div className="flex flex-wrap gap-2">
                <ActionButton disabled={pendingAction !== null} onClick={() => applyStatus("accepted")} tone="positive">
                  <CheckCircle2 size={15} />
                  {pendingAction === "accepted" ? "Accepting..." : "Accept"}
                </ActionButton>
                <ActionButton disabled={pendingAction !== null} onClick={() => applyStatus("dismissed")} tone="danger">
                  <XCircle size={15} />
                  {pendingAction === "dismissed" ? "Dismissing..." : "Dismiss"}
                </ActionButton>
                {actions?.canMarkExpired ? (
                  <ActionButton disabled={pendingAction !== null} onClick={() => applyStatus("expired")}>
                    <Clock3 size={15} />
                    {pendingAction === "expired" ? "Marking expired..." : "Mark expired"}
                  </ActionButton>
                ) : null}
              </div>
            ) : selectedOpportunity.status === "accepted" ? (
              <div className="space-y-3">
                {!selectedJob ? (
                  <>
                    <p className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm">This Opportunity is accepted. Create one Creative Job to prove the worker pipeline without generating real content.</p>
                    <ActionButton disabled={isCreatingJob || Boolean(jobError)} onClick={createJob} tone="positive">
                      <BriefcaseBusiness size={15} />
                      {isCreatingJob ? "Creating job..." : "Create Job"}
                    </ActionButton>
                  </>
                ) : (
                  <p className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm">This Opportunity already has one Creative Job. Job records are read-only in this milestone.</p>
                )}
              </div>
            ) : (
              <p className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm">This Opportunity is read-only because its status is {selectedOpportunity.status}.</p>
            )}

            {jobError ? <MessageBox message={jobError} tone="bad" /> : null}
            {selectedJob ? (
              <section className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <BriefcaseBusiness className="text-[#9a5b2f]" size={17} />
                    <h4 className="font-semibold text-[#211713]">Creative Job</h4>
                  </div>
                  <Tag tone={creativeJobStatusTone(selectedJob.status)}>Status: {getCreativeJobStatusLabel(selectedJob.status)}</Tag>
                </div>
                <div className="mt-3 grid gap-3">
                  {metadataBlock("Worker type", selectedJob.workerType)}
                  {metadataBlock("Attempts", String(selectedJob.attemptCount))}
                  {metadataBlock("Queued", formatDateTime(selectedJob.createdAt))}
                  {selectedJob.startedAt ? metadataBlock("Started", formatDateTime(selectedJob.startedAt)) : null}
                  {selectedJob.completedAt ? metadataBlock("Completed", formatDateTime(selectedJob.completedAt)) : null}
                  {selectedJob.failedAt ? metadataBlock("Failed", formatDateTime(selectedJob.failedAt)) : null}
                  {selectedJob.lastError ? metadataBlock("Last error", selectedJob.lastError) : null}
                </div>
                <details className="mt-3 rounded-md border border-[#ead9c8] bg-white p-3" open={isCreativeJobTerminal(selectedJob)}>
                  <summary className="cursor-pointer text-sm font-semibold text-[#5f4a3d]">View job detail</summary>
                  {isCreativeJobResultEnvelope(selectedJob.result) ? (
                    <div className="mt-3 grid gap-3">
                      {metadataBlock("Schema version", selectedJob.result.schemaVersion)}
                      {metadataBlock("Worker", selectedJob.result.worker)}
                      {metadataBlock("Headline", selectedJob.result.output.headline)}
                      {metadataBlock("Caption", selectedJob.result.output.caption)}
                      {metadataBlock("Artifacts", `${selectedJob.result.artifacts.length}`)}
                    </div>
                  ) : null}
                  <pre className="mt-3 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#231813] p-3 text-xs leading-5 text-[#fff8ef]">{formatOpportunityRawJson(selectedJob.result)}</pre>
                </details>
                {packageError ? <MessageBox message={packageError} tone="bad" /> : null}
                {selectedJob.status === "completed" ? (
                  <section className="mt-3 rounded-md border border-[#ead9c8] bg-white p-3">
                    <div className="flex items-center gap-2">
                      <PackageCheck className="text-[#9a5b2f]" size={17} />
                      <h4 className="font-semibold text-[#211713]">Creative Package</h4>
                    </div>
                    {selectedPackage ? (
                      <details className="mt-3 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3" open>
                        <summary className="cursor-pointer text-sm font-semibold text-[#5f4a3d]">View Package</summary>
                        <div className="mt-3 grid gap-3">
                          {metadataBlock("Package status", selectedPackage.status)}
                          {metadataBlock("Schema version", selectedPackage.schemaVersion)}
                          {isCreativePackageContentV1(selectedPackage.content) ? (
                            <>
                              {metadataBlock("Headline", selectedPackage.content.output.headline)}
                              {metadataBlock("Caption", selectedPackage.content.output.caption)}
                              {metadataBlock("Source Creative Job ID", selectedPackage.content.metadata.sourceCreativeJobId)}
                              {metadataBlock("Source worker", selectedPackage.content.metadata.sourceWorker)}
                              {metadataBlock("Generated from Opportunity ID", selectedPackage.content.metadata.generatedFromOpportunity)}
                              {metadataBlock("Generator version", selectedPackage.content.metadata.generatorVersion)}
                              <div className="text-sm">
                                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Artifacts</p>
                                {selectedPackage.content.artifacts.length > 0 ? (
                                  <ul className="mt-1 list-disc pl-5">
                                    {selectedPackage.content.artifacts.map((artifact, index) => (
                                      <li key={index}>{String(artifact)}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="mt-1 font-semibold">No artifacts recorded for this mock package.</p>
                                )}
                              </div>
                            </>
                          ) : (
                            <p className="text-sm text-[#6f5a4c]">This Creative Package uses an unsupported content shape.</p>
                          )}
                        </div>
                        <details className="mt-3 rounded-md border border-[#ead9c8] bg-white p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-[#5f4a3d]">Raw package JSON</summary>
                          <pre className="mt-3 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#231813] p-3 text-xs leading-5 text-[#fff8ef]">{formatOpportunityRawJson(selectedPackage.content)}</pre>
                        </details>
                      </details>
                    ) : (
                      <p className="mt-3 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm">No Creative Package has been materialized yet.</p>
                    )}
                  </section>
                ) : null}
              </section>
            ) : null}

            <div className="grid gap-3">
              {metadataBlock("Evidence version", selectedOpportunity.evidenceVersion)}
              {metadataBlock("Deduplication key", selectedOpportunity.deduplicationKey)}
              {metadataBlock("Created", formatDateTime(selectedOpportunity.createdAt))}
              {metadataBlock("Updated", formatDateTime(selectedOpportunity.updatedAt))}
            </div>

            <div className="space-y-3">
              {evidenceSections.map((section) => (
                <section className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3" key={section.title}>
                  <h4 className="font-semibold text-[#211713]">{section.title}</h4>
                  {section.rows.length > 0 ? (
                    <div className="mt-2 grid gap-2">
                      {section.rows.map((row) => (
                        <div className="grid gap-1" key={`${section.title}-${row.label}`}>
                          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#8a7465]">{row.label}</p>
                          <p className="break-words">{row.value}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {section.lines && section.lines.length > 0 ? (
                    <div className="mt-2 grid gap-2">
                      {section.lines.map((line) => <p className="break-words" key={line}>{line}</p>)}
                    </div>
                  ) : null}
                </section>
              ))}
            </div>

            <details className="rounded-md border border-[#ead9c8] bg-white p-3">
              <summary className="cursor-pointer text-sm font-semibold text-[#5f4a3d]">Raw evidence JSON</summary>
              <pre className="mt-3 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#231813] p-3 text-xs leading-5 text-[#fff8ef]">{rawEvidence}</pre>
            </details>
          </div>
        ) : null}
      </Panel>
    </section>
  );
}
