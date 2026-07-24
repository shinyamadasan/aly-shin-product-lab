import { useState } from "react";
import { Sparkles } from "lucide-react";
import { FormPanel, MessageBox, SecondaryButton, Textarea } from "@/components/ui";
import type { AiAction, AiReviewRecord, CostingSummary, Product, ProductBatch, SpecialistId, SupplyEntry, TastingFeedback } from "@/lib/product-lab-types";
import { AI_ACTIONS, generateAdvisorPrompt } from "@/services/ai/advisor";
import { SPECIALISTS } from "@/services/ai/specialists";
import type { AiPromptResult } from "@/services/ai/types";

// The AI Advisor is a Copy-Prompt tool, not a live AI integration -- see docs/ARCHITECTURE.md
// "AI Advisor". It only ever assembles a deterministic prompt from data already computed
// elsewhere (the Rule Engine, Costing, Supplies); nothing here calls a network API, so there is
// no "AI unavailable" failure mode to handle -- the feature works identically with or without an
// AI provider ever being wired up.
export function AiAdvisorPanel({
  batches,
  costings,
  deleteReview,
  isTableMissing,
  product,
  reviews,
  saveReview,
  supplies,
  tastings,
}: {
  batches: ProductBatch[];
  costings: CostingSummary[];
  deleteReview: (reviewId: string) => void;
  isTableMissing: boolean;
  product: Product;
  reviews: AiReviewRecord[];
  saveReview: (review: { productId: string; batchId: string; action: AiAction; specialists: SpecialistId[]; prompt: string; response: string }) => void;
  supplies: SupplyEntry[];
  tastings: TastingFeedback[];
}) {
  const [activeResult, setActiveResult] = useState<AiPromptResult | null>(null);
  const [responseDraft, setResponseDraft] = useState("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const latestBatchId = batches.find((batch) => batch.productId === product.id)?.id ?? "";

  function runAction(action: AiAction, now: number) {
    const context = { batches, costings, now, supplies, tastings };
    setActiveResult(generateAdvisorPrompt(action, product, context));
    setResponseDraft("");
    setCopyStatus("idle");
  }

  async function copyPrompt() {
    if (!activeResult) {
      return;
    }
    try {
      await navigator.clipboard.writeText(activeResult.prompt);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  function saveActiveReview() {
    if (!activeResult) {
      return;
    }
    saveReview({
      action: activeResult.action,
      batchId: latestBatchId,
      productId: product.id,
      prompt: activeResult.prompt,
      response: responseDraft,
      specialists: activeResult.specialists,
    });
    setActiveResult(null);
    setResponseDraft("");
  }

  return (
    <FormPanel title="AI Advisor" icon={<Sparkles size={18} />}>
      {isTableMissing ? (
        <div className="mb-4 rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
          AI review storage is not ready yet. Run <strong>supabase-add-ai-reviews.sql</strong> once, then Save Review will start working. Copy Prompt still works without it.
        </div>
      ) : null}
      <p className="text-sm leading-6 text-[#6f5a4c]">
        Explains, recommends, and brainstorms on top of what the Rule Engine and Costing have already computed -- it never recalculates margin, readiness, or any other deterministic check itself. Pick an action to generate a prompt, copy it into your AI chat of choice, then paste the reply back to save it here.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {AI_ACTIONS.map((entry) => (
          <SecondaryButton key={entry.action} onClick={() => runAction(entry.action, Date.now())}>
            ✨ {entry.label}
          </SecondaryButton>
        ))}
      </div>

      {activeResult ? (
        <div className="mt-4 grid gap-3 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-[#8a7465]">
            {AI_ACTIONS.find((entry) => entry.action === activeResult.action)?.question} -- {activeResult.specialists.map((id) => SPECIALISTS[id].name).join(", ")}
          </p>
          <Textarea label="Prompt to copy" readOnly rows={10} value={activeResult.prompt} />
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton onClick={copyPrompt}>Copy Prompt</SecondaryButton>
            {copyStatus === "copied" ? <span className="text-xs font-medium text-[#2e6b44]">Copied.</span> : null}
            {copyStatus === "failed" ? <span className="text-xs font-medium text-[#8a3827]">Couldn&apos;t copy automatically -- select the text above and copy manually.</span> : null}
          </div>
          <Textarea
            helper="Paste the AI's reply here to keep it with this product."
            label="AI response"
            onChange={(event) => setResponseDraft(event.target.value)}
            rows={6}
            value={responseDraft}
          />
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={saveActiveReview}>Save Review</SecondaryButton>
            <SecondaryButton onClick={() => setActiveResult(null)}>Discard</SecondaryButton>
          </div>
        </div>
      ) : null}

      {reviews.length > 0 ? (
        <div className="mt-5 grid gap-3">
          <h4 className="text-sm font-semibold">Saved reviews</h4>
          {reviews.map((review) => (
            <details className="rounded-md border border-[#ead9c8] bg-white p-3" key={review.id}>
              <summary className="cursor-pointer text-sm font-medium">
                {AI_ACTIONS.find((entry) => entry.action === review.action)?.label ?? review.action} -- {new Date(review.createdAt).toLocaleString()}
              </summary>
              <div className="mt-3 grid gap-3 text-sm leading-6 text-[#5f4a3d]">
                <p className="text-xs text-[#8a7465]">Specialists: {review.specialists.map((id) => SPECIALISTS[id]?.name ?? id).join(", ") || "None recorded"}</p>
                {review.response ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#8a7465]">Response</p>
                    <p className="whitespace-pre-wrap">{review.response}</p>
                  </div>
                ) : (
                  <MessageBox message="Prompt generated but no response pasted back yet." tone="info" />
                )}
                <details>
                  <summary className="cursor-pointer text-xs text-[#8a7465]">Show prompt</summary>
                  <p className="mt-2 whitespace-pre-wrap text-xs">{review.prompt}</p>
                </details>
                <SecondaryButton onClick={() => deleteReview(review.id)}>Delete</SecondaryButton>
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </FormPanel>
  );
}
