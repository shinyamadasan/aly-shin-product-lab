"use client";

import { useEffect, useState } from "react";
import { Button, MessageBox } from "@/components/ui";
import {
  CREATE_NOW_DEFAULT_FORMAT_CHOICE,
  CREATE_NOW_FORMAT_OPTIONS,
  CREATE_NOW_JOB_SEARCH_PARAM,
  CREATE_NOW_NO_PRODUCT_CHOICE,
  CREATE_NOW_NO_PRODUCT_LABEL,
  CREATE_NOW_POLL_INTERVAL_MS,
  buildCreateNowRequest,
  describeCreateNowScreenProgress,
  findSelectableCreateNowProduct,
  selectableCreateNowProducts,
  shouldRefreshCreateNowJob,
  type CreateNowFormatChoice,
} from "@/lib/create-now";
import { buildCreativePackageView, formatCreativePackageForClipboard, formatHashtags, type CreativePackageView } from "@/lib/creative-package-view";
import { createCreativeJobFromRequest, getCreativeJobById, type CreativeJobClient, type CreativeJobRecord } from "@/lib/creative-jobs";
import { getCreativePackageForJob, type CreativePackageClient } from "@/lib/creative-packages";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import type { Product } from "@/lib/product-lab-types";

// Content Creation MVP S4 -- the owner's on-demand creation surface.
//
// THE WHOLE POINT: the owner types one sentence and taps once. Product and format are optional and
// deliberately secondary; nothing else is asked, and no AI setting is exposed, because the question
// this screen puts to the owner is "what do I want to make?", not "how should the AI be configured?".
//
// This component QUEUES work. It never runs it. Submitting writes one row through the existing
// request-backed domain entry point and returns; the already-running background worker picks the
// job up on its own schedule. No AI provider is reachable from the browser, and no code path here
// waits on generation.
//
// It also never touches the Opportunity domain. There is no Opportunity import in this file and no
// Opportunity is created, read or faked -- a direct request is its own origin, which is exactly why
// createCreativeJobFromRequest exists separately from createCreativeJobForAcceptedOpportunity.

// h-11 rather than S4's h-9: this is the control the owner taps on a phone, in a kitchen, and 36px
// was under the comfortable tap target.
function CopyAction({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="inline-flex h-11 items-center rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d] hover:bg-[#fffaf3]"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      }}
      type="button"
    >
      {copied ? `${label} copied` : label}
    </button>
  );
}

function QuietAction({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button className="text-sm font-medium text-[#6f5a4c] underline-offset-4 hover:underline" onClick={onClick} type="button">
      {children}
    </button>
  );
}

function PrimaryAction({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button className="h-10 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white hover:bg-[#774427]" onClick={onClick} type="button">
      {children}
    </button>
  );
}

// S5 -- the completed view answers, in this order: what am I making, what exactly do I do, what
// exactly do I post, and only then why. Strategy vocabulary (Angle, Hook, Headline, CTA) is real and
// kept, but it is the LAST thing on the screen and it is collapsed, because none of it is something
// the owner does with their hands. Nothing is generated here; the order is the whole change.
function PackageView({ view }: { view: CreativePackageView }) {
  return (
    <div className="space-y-5">
      {/* 1. What am I making. The package's own subject and format -- no second invented title.
          S6 puts the Reel's whole-video length on this line too: it is a property of the thing being
          made, so it belongs in the summary rather than buried under the last shot. Absent for every
          other format, and the row then renders exactly as it did in S5. */}
      <div>
        <h3 className="text-xl font-semibold tracking-tight text-[#211713]">{view.subject}</h3>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <p className="text-sm text-[#6f5a4c]">{view.formatLabel}</p>
          {view.durationLabel ? <p className="text-sm text-[#6f5a4c]">{view.durationLabel}</p> : null}
        </div>
        {/* P1 §6 -- how it gets made, on its own labelled row directly under the format. A row and
            not a card: the production route is one short phrase, and giving it a bordered panel
            would make the quietest fact on the screen the loudest thing on it.

            The PRODUCTION label reuses the same small-caps treatment every other "which question is
            this the answer to" label already uses, so it reads as a peer of Show / Do / Text on
            screen rather than as new furniture. Absent on pre-H1-B packages, which renders nothing
            at all rather than an empty row. */}
        {view.productionLabel ? (
          <div className="mt-2 flex items-baseline gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Production</p>
            <p className="text-sm text-[#4a3c32]">{view.productionLabel}</p>
          </div>
        ) : null}
      </div>

      {/* 2. What exactly do I do. First, because it is the only part that needs hands.

          Three levels, each earning its place: the section says what activity this is, the block
          title names the unit being produced ("Slide 2"), and every line is labelled with the
          question it answers -- Show / Text on slide / Do / Text on screen. The owner should never
          have to work out whether a line is something to point a camera at or something to type. */}
      {view.production.map((section, sectionIndex) => (
        <section className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-4" key={sectionIndex}>
          {section.title ? <h4 className="text-base font-semibold text-[#211713]">{section.title}</h4> : null}
          <div className={section.title ? "mt-3 space-y-4" : "space-y-4"}>
            {section.blocks.map((block, blockIndex) => (
              <div key={blockIndex}>
                {block.title ? <p className="text-sm font-semibold text-[#211713]">{block.title}</p> : null}
                <div className={block.title ? "mt-1.5 space-y-1.5" : "space-y-1.5"}>
                  {block.lines.map((line, lineIndex) => (
                    <div key={lineIndex}>
                      {line.label ? <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{line.label}</p> : null}
                      <p
                        className={`whitespace-pre-wrap break-words leading-6 text-[#4a3c32] ${
                          line.label === null && block.title === null ? "text-base" : "text-sm"
                        }`}
                      >
                        {line.value}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* 3. What exactly do I post. Platform-ready copy when the generator wrote any; otherwise the
          base caption IS the ready-to-post copy, so it takes this place rather than competing with it. */}
      <section className="space-y-3">
        <h4 className="text-base font-semibold text-[#211713]">Then post this</h4>
        {view.platformVariants.length > 0 ? (
          view.platformVariants.map((variant) => (
            <div className="rounded-md border border-[#ead9c8] bg-white p-4" key={variant.platform}>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{variant.label}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-base leading-6 text-[#4a3c32]">{variant.caption}</p>
              {variant.hashtags.length > 0 ? <p className="mt-1 break-words text-sm leading-6 text-[#6f5a4c]">{formatHashtags(variant.hashtags)}</p> : null}
              <div className="mt-3">
                <CopyAction label={`Copy ${variant.label} caption`} value={variant.caption} />
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-md border border-[#ead9c8] bg-white p-4">
            <p className="whitespace-pre-wrap break-words text-base leading-6 text-[#4a3c32]">{view.caption}</p>
            <div className="mt-3">
              <CopyAction label="Copy caption" value={view.caption} />
            </div>
          </div>
        )}
      </section>

      {/* The quieter general-copy row. Keeps the base caption and the rest reachable without letting
          them compete with the platform-ready copy above. */}
      <div className="flex flex-wrap gap-2">
        <CopyAction label="Copy caption" value={view.caption} />
        <CopyAction label="Copy headline" value={view.headline} />
        {view.script ? <CopyAction label="Copy script" value={view.script} /> : null}
        <CopyAction label="Copy everything" value={formatCreativePackageForClipboard(view)} />
      </div>

      {/* 4. Why the AI chose this. Kept in full, collapsed by default. Native <details> -- no state,
          no JavaScript, keyboard-operable, and already how this app collapses secondary detail. */}
      <details className="rounded-md border border-[#ead9c8] bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold text-[#5f4a3d]">Creative details</summary>
        <div className="mt-3 space-y-3">
          {view.creativeDetails.map((detail) => (
            <div key={detail.label}>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{detail.label}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-[#4a3c32]">{detail.value}</p>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

export function CreateNow({
  jobId,
  onExit,
  onJobIdChange,
  products,
}: {
  // Owned by the surface that hosts this component, so stepping away and back does not resurrect a
  // job the owner already moved on from.
  jobId: string | null;
  onExit: (() => void) | null;
  onJobIdChange: (jobId: string | null) => void;
  products: Product[];
}) {
  const jobClient = supabase as unknown as CreativeJobClient | null;
  const packageClient = supabase as unknown as CreativePackageClient | null;

  const [text, setText] = useState("");
  const [productId, setProductId] = useState(CREATE_NOW_NO_PRODUCT_CHOICE);
  const [formatChoice, setFormatChoice] = useState<CreateNowFormatChoice>(CREATE_NOW_DEFAULT_FORMAT_CHOICE);
  const [validationMessage, setValidationMessage] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [job, setJob] = useState<CreativeJobRecord | null>(null);
  const [jobError, setJobError] = useState("");
  const [packageView, setPackageView] = useState<CreativePackageView | null>(null);
  const [packageError, setPackageError] = useState("");
  // Counts the completed-job looks that found no package yet. Bounds the grace window in
  // shouldRefreshCreateNowJob, so waiting for a late package can never become an endless poll.
  const [packageMissCount, setPackageMissCount] = useState(0);
  const [pollTick, setPollTick] = useState(0);
  // AH1 §16. The clock is READ where the job is read, never during render: Date.now() in a render
  // body is an impure call, and the elapsed value has nothing to say until there is a job to measure.
  // It therefore moves in the same ~4.5s steps the status already moves in, which adds no timer of
  // its own and is exactly the resolution the question "has this been sitting here?" needs.
  //
  // 0 until the first read lands, which createNowElapsedMs reads as a negative duration and reports
  // as "no elapsed time" -- the same honest answer it gives for a missing or skewed timestamp.
  const [nowMs, setNowMs] = useState(0);

  const selectable = selectableCreateNowProducts(products);

  // Reads exactly one job, by id, and only that job's own package. No list, no history, no second
  // table -- a refresh cycle that loaded every job would get slower the longer the app is used.
  useEffect(() => {
    if (!jobId || !jobClient) {
      return;
    }

    let cancelled = false;

    async function load(id: string, client: CreativeJobClient) {
      const jobResult = await getCreativeJobById(client, id);
      if (cancelled) return;

      if (!jobResult.ok) {
        setJobError(jobResult.message);
        return;
      }

      setJobError("");
      setJob(jobResult.job);
      setNowMs(Date.now());

      if (jobResult.job.status !== "completed" || !packageClient) {
        return;
      }

      const packageResult = await getCreativePackageForJob(packageClient, jobResult.job.id);
      if (cancelled) return;

      if (!packageResult.ok) {
        // "not-found" the instant a job completes is normal, not an error: the worker writes the
        // package a moment after the job. It is not treated as a failure -- it spends one look from
        // the bounded grace window, and the next refresh picks the package up.
        if (packageResult.reason === "not-found") {
          setPackageError("");
          setPackageMissCount((current) => current + 1);
          return;
        }
        setPackageError(packageResult.message);
        return;
      }

      const built = buildCreativePackageView(packageResult.creativePackage.content);
      if (!built.ok) {
        setPackageError("This one came back in a shape we can't show yet.");
        return;
      }

      setPackageError("");
      setPackageView(built.view);
    }

    load(jobId, jobClient);
    return () => {
      cancelled = true;
    };
  }, [jobId, jobClient, packageClient, pollTick]);

  // Only ever the job currently on screen. A job read that belongs to a previous id is not this
  // job's status and must not keep its timer alive.
  const refreshStatus = job !== null && job.id === jobId ? job.status : null;

  const refreshState = {
    status: refreshStatus,
    hasJobError: jobError !== "",
    hasPackage: packageView !== null,
    hasPackageError: packageError !== "",
    packageMissCount,
  };

  // One pending timer at a time, re-armed after every refresh, and every stopping condition lives in
  // shouldRefreshCreateNowJob. clearTimeout on unmount means leaving the screen stops the refreshing
  // immediately -- the job itself carries on regardless, because generation was never happening here.
  useEffect(() => {
    if (!jobId) {
      return;
    }
    if (!shouldRefreshCreateNowJob({ status: refreshStatus, hasJobError: jobError !== "", hasPackage: packageView !== null, hasPackageError: packageError !== "", packageMissCount })) {
      return;
    }

    const timer = setTimeout(() => setPollTick((current) => current + 1), CREATE_NOW_POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [jobId, refreshStatus, jobError, packageView, packageError, packageMissCount, pollTick]);

  // Records the active job in both places that have to agree: the host surface's state, and the URL
  // so a refresh, a re-open, or coming back later lands on the same job instead of an empty form.
  // Deliberately history.replaceState rather than a router push -- this is the same screen showing
  // the same thing, not a new place to go back from, and a navigation here would re-run the route.
  function setActiveJob(id: string | null) {
    onJobIdChange(id);
    const url = new URL(window.location.href);
    if (id === null) {
      url.searchParams.delete(CREATE_NOW_JOB_SEARCH_PARAM);
    } else {
      url.searchParams.set(CREATE_NOW_JOB_SEARCH_PARAM, id);
    }
    window.history.replaceState(null, "", url);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // The in-flight guard. A second tap while the first request is still going does nothing at all,
    // which is the right boundary for this: two DELIBERATE requests for the same thing are two
    // genuine requests and must both be honoured, so nothing further back than the button is
    // deduplicated.
    if (isSubmitting) {
      return;
    }

    const built = buildCreateNowRequest({ text, product: findSelectableCreateNowProduct(products, productId), formatChoice });
    if (!built.ok) {
      setValidationMessage(built.message);
      return;
    }

    if (!jobClient) {
      setSubmitError("Making content needs the shared workspace connection.");
      return;
    }

    setValidationMessage("");
    setSubmitError("");
    setIsSubmitting(true);

    const created = await createCreativeJobFromRequest(jobClient, built.request, { workerType: "creative_ai" });
    setIsSubmitting(false);

    if (!created.ok) {
      setSubmitError(created.message);
      return;
    }

    // Straight to the waiting state on the row we just wrote -- no second read, and above all no
    // wait on generation. The submit button's busy state ends here, a second or so in, rather than
    // pretending to load for as long as the AI takes.
    setJob(created.job);
    setNowMs(Date.now());
    setActiveJob(created.job.id);
  }

  // Clears the presentation only. The finished job and its package stay exactly where they are --
  // this is "start another", never "delete that one".
  function createAnother() {
    setJob(null);
    setJobError("");
    setPackageView(null);
    setPackageError("");
    setPackageMissCount(0);
    setText("");
    setProductId(CREATE_NOW_NO_PRODUCT_CHOICE);
    setFormatChoice(CREATE_NOW_DEFAULT_FORMAT_CHOICE);
    setActiveJob(null);
  }

  if (jobId !== null) {
    const progress =
      job === null
        ? null
        : describeCreateNowScreenProgress(job.status, refreshState, { createdAt: job.createdAt, startedAt: job.startedAt, nowMs });

    return (
      <section className="mx-auto max-w-xl space-y-5">
        <div aria-live="polite" className="space-y-2">
          {progress ? (
            <h2 className="text-2xl font-semibold tracking-tight">
              {progress.headline}
              {progress.elapsedLabel ? (
                <span className="ml-2 font-normal tabular-nums text-[#6f5a4c]">{progress.elapsedLabel}</span>
              ) : null}
            </h2>
          ) : null}
          {progress && progress.detail ? <p className="text-sm leading-6 text-[#6f5a4c]">{progress.detail}</p> : null}
        </div>

        {jobError ? <MessageBox message={jobError} tone="bad" /> : null}
        {packageError ? <MessageBox message={packageError} tone="bad" /> : null}

        {/* The bounded grace window running out needs no separate notice: describeCreateNowScreenProgress
            has already said it in the heading and detail above, in the same calm shape every other
            waiting state uses. An amber box here would style a slow write as something gone wrong. */}

        {packageView ? <PackageView view={packageView} /> : null}

        {/* On a failure this is the only thing left to do, so it is the screen's primary action. On
            success it stays quiet: the owner's next step is to go and use what they just got, not to
            immediately ask for more. */}
        {progress && progress.tone === "bad" ? <PrimaryAction onClick={createAnother}>Create another</PrimaryAction> : null}
        {progress && progress.isSettled && progress.tone !== "bad" ? <QuietAction onClick={createAnother}>Create another</QuietAction> : null}
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-xl space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a5b2f]">Something specific</p>
        <h2 className="mt-1 text-3xl font-semibold tracking-tight">What do you want to make?</h2>
      </div>

      {!isSupabaseConfigured ? (
        <MessageBox message="Making content needs the shared workspace connection." tone="bad" />
      ) : null}

      <form className="space-y-5" onSubmit={submit}>
        {/* The heading above already asks the question, so repeating it as a visible field label
            would say the same thing twice. The label still exists for anyone who cannot see the
            heading's relationship to the field -- it is hidden, not absent. */}
        <div className="grid gap-1">
          <label className="sr-only" htmlFor="create-now-text">
            What do you want to make?
          </label>
          <textarea
            aria-describedby={validationMessage ? "create-now-text-error" : undefined}
            aria-invalid={validationMessage ? true : undefined}
            className="min-h-36 w-full rounded-md border border-[#d8c7b7] bg-white p-3 text-base"
            id="create-now-text"
            onChange={(event) => setText(event.target.value)}
            placeholder="Give me something easy today"
            rows={5}
            value={text}
          />
        </div>
        {validationMessage ? (
          <p className="text-sm font-medium text-[#8a3827]" id="create-now-text-error" role="alert">
            {validationMessage}
          </p>
        ) : null}

        <label className="grid gap-1 text-sm font-medium">
          Product — optional
          <select
            className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3"
            onChange={(event) => setProductId(event.target.value)}
            value={productId}
          >
            <option value={CREATE_NOW_NO_PRODUCT_CHOICE}>{CREATE_NOW_NO_PRODUCT_LABEL}</option>
            {selectable.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Format — optional</legend>
          <div className="flex flex-wrap gap-2">
            {CREATE_NOW_FORMAT_OPTIONS.map((option) => (
              <label className="cursor-pointer" key={option.value}>
                <input
                  checked={formatChoice === option.value}
                  className="peer sr-only"
                  name="create-now-format"
                  onChange={() => setFormatChoice(option.value)}
                  type="radio"
                  value={option.value}
                />
                <span className="inline-flex h-10 items-center rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d] peer-checked:border-[#231813] peer-checked:bg-[#231813] peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#8f5632]">
                  {option.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Button disabled={isSubmitting}>{isSubmitting ? "Sending your request..." : "Create content"}</Button>
      </form>

      {submitError ? <MessageBox message={submitError} tone="bad" /> : null}

      {onExit ? <QuietAction onClick={onExit}>Back to today</QuietAction> : null}
    </section>
  );
}
