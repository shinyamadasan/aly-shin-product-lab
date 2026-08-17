import { isCreativeFormat, type CreativeFormat } from "./creative-formats.ts";
import type { CreativeRequest } from "./creative-input.ts";
import type { CreativeJobStatus } from "./creative-jobs.ts";
import type { Product } from "./product-lab-types.ts";

// Content Creation MVP S4 -- the Create Now form's own pure logic, kept out of the component so
// every rule below is provable without a DOM.
//
// This module maps owner input onto the EXISTING CreativeRequest contract. It defines no second
// request shape, no second format vocabulary, and no second product source: formats come from
// creative-formats.ts, the request type from creative-input.ts, and products are handed in already
// loaded by the app's own catalog read.

// --- format ------------------------------------------------------------------------------------
//
// "Let AI choose" is a UI-only choice, not a fifth format. It exists so the control has something
// to be, and it maps to a null formatHint -- never to "photo". A default of photo would be the app
// silently making a creative decision and then reporting it as the owner's, which is exactly what
// CreativeInput.formatHint's "never an AI decision" rule exists to prevent.
export const CREATE_NOW_AI_FORMAT_CHOICE = "ai";

export type CreateNowFormatChoice = typeof CREATE_NOW_AI_FORMAT_CHOICE | CreativeFormat;

export const CREATE_NOW_FORMAT_OPTIONS: ReadonlyArray<{ value: CreateNowFormatChoice; label: string }> = [
  { value: CREATE_NOW_AI_FORMAT_CHOICE, label: "Let AI choose" },
  { value: "photo", label: "Photo" },
  { value: "reel", label: "Reel" },
  { value: "carousel", label: "Carousel" },
  { value: "story", label: "Story" },
];

export const CREATE_NOW_DEFAULT_FORMAT_CHOICE: CreateNowFormatChoice = CREATE_NOW_AI_FORMAT_CHOICE;

export function toCreativeFormatHint(choice: CreateNowFormatChoice): CreativeFormat | null {
  return isCreativeFormat(choice) ? choice : null;
}

// --- product -----------------------------------------------------------------------------------

export const CREATE_NOW_NO_PRODUCT_CHOICE = "";

export const CREATE_NOW_NO_PRODUCT_LABEL = "Let AI choose";

// Paused products are excluded because the existing product lifecycle already excludes them from
// content: marketing-recommendations.ts refuses to recommend a paused product at all. Offering one
// here would let Create Now produce content the rest of the system has decided not to make.
//
// Order is preserved exactly as loaded (the catalog read orders by name); no second sort is applied.
export function selectableCreateNowProducts(products: Product[]): Product[] {
  return products.filter((product) => product.status !== "paused");
}

export function findSelectableCreateNowProduct(products: Product[], productId: string): Product | null {
  return selectableCreateNowProducts(products).find((product) => product.id === productId) ?? null;
}

// --- request building --------------------------------------------------------------------------

export type CreateNowFormValues = {
  text: string;
  // Already resolved by the caller from the selectable list -- this module never looks a product up
  // by id, so it can never resurrect a paused or deleted one.
  product: Product | null;
  formatChoice: CreateNowFormatChoice;
};

export type CreateNowRequestResult = { ok: true; request: CreativeRequest } | { ok: false; message: string };

export const CREATE_NOW_EMPTY_TEXT_MESSAGE = "Type what you want to make first.";

// The only required field is text, and "required" means "has a non-whitespace character in it" --
// nothing else about the owner's sentence is inspected, corrected or parsed. In particular no
// format, product or subject is ever extracted from the prose: guessing those from free text is the
// silent reinterpretation the structured controls exist to avoid.
//
// text is submitted VERBATIM, not trimmed. Whitespace is trimmed for the emptiness check only,
// because CreativeInput.requestText is contractually the owner's original words and rewriting them
// -- even by stripping spaces -- is the quiet edit that field exists to prevent.
export function buildCreateNowRequest(values: CreateNowFormValues): CreateNowRequestResult {
  if (values.text.trim().length === 0) {
    return { ok: false, message: CREATE_NOW_EMPTY_TEXT_MESSAGE };
  }

  const request: CreativeRequest = {
    text: values.text,
    formatHint: toCreativeFormatHint(values.formatChoice),
  };

  if (values.product !== null) {
    // subject is set alongside productId deliberately, and it is not an invented fact: it is the
    // catalog product's own name, verbatim, and picking that product from a list IS the owner
    // stating what the content is about.
    //
    // It is also load-bearing. S3A's resolveCreativeGrounding only honours an explicitly stated
    // subject at step 1; a request carrying productId with a null subject falls straight through to
    // the recommendation/Journey/brand fallbacks, and the owner's chosen product would never reach
    // the generator at all. Sending all three is what makes the selector mean anything.
    request.subject = values.product.name;
    request.productId = values.product.id;
    request.productName = values.product.name;
  }

  return { ok: true, request };
}

// --- job lifecycle, in the owner's language ----------------------------------------------------
//
// The four persisted Creative Job statuses, said plainly. No status code, worker name, attempt
// count, provider or schema version appears in any string here -- Today's language rule (see
// planning/today-product-spec.md §10) bans words that describe the machinery rather than the
// moment, and this surface lives on Today.
//
// The timing copy is deliberately vague about duration. The local worker runs about once a minute
// and generation itself takes tens of seconds, so any specific promise ("about 30 seconds") would
// be wrong most of the time.
export type CreateNowProgress = {
  headline: string;
  detail: string;
  tone: "info" | "good" | "bad";
  isSettled: boolean;
  // AH1 §16. Null whenever there is nothing honest to show: a settled job, a missing timestamp, or a
  // clock disagreement that would render as a negative or nonsense duration. Showing no timer is
  // always better than showing a wrong one.
  elapsedLabel: string | null;
};

export const CREATE_NOW_WAITING_DETAIL = "This can take a minute or two. You can leave this page while it finishes.";

// AH1 §14-17 -- the timing the waiting states are read against.
//
// The incident this comes from: a job sat queued for roughly fifteen minutes while the local worker
// was wedged, and the screen said "We've got your request. Starting shortly." for every one of those
// minutes. The copy was never wrong about the STATUS -- the job really was queued -- it was just
// silent about the only thing the owner needed, which was that nothing had picked it up and nothing
// was going to. The owner waited because the screen gave them no reason not to.
//
// Both timestamps are already persisted and already read: created_at is written when the row is
// inserted and started_at when the claim RPC takes the job. Nothing here needed a migration, and
// nothing here writes.
export type CreateNowJobTiming = {
  createdAt: string;
  // "" when the job has not been claimed yet -- fromCreativeJobRow already normalises the null.
  startedAt: string;
  // Injected rather than read from a module-level clock, so every threshold below is provable
  // without waiting in real time.
  nowMs: number;
};

// Conservative on purpose, and deliberately NOT failure semantics. Crossing either line changes what
// the screen SAYS and nothing else: no job is failed, cancelled, retried, or otherwise touched. The
// worker owns the job's state and this module never writes to it.
//
// Two minutes for a queue whose worker wakes every minute means a healthy pickup never trips it, and
// a worker that is genuinely absent is reported inside the second cycle. Three minutes for a running
// job sits well above the twenty-to-forty seconds a normal generation takes, and well below the
// fifteen-minute ceiling a legitimately long one is still allowed.
export const CREATE_NOW_QUEUED_SLOW_MS = 2 * 60 * 1000;
export const CREATE_NOW_RUNNING_SLOW_MS = 3 * 60 * 1000;

// m:ss. Null rather than a fallback string for anything that is not a sane forward duration --
// including a negative one, which is what a browser clock running behind the database clock produces
// and which must never render as "-0:03" or wrap around to something reassuring.
export function formatCreateNowElapsed(elapsedMs: number): string | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return null;
  }
  const totalSeconds = Math.floor(elapsedMs / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

// Which timestamp a state is measured from -- and it is a different one per state, which is the
// whole point. Queued time is time since the owner ASKED (created_at); running time is time since
// the worker STARTED (started_at). Measuring both from created_at would report a fast generation
// that waited a while in the queue as a slow generation.
//
// A running job with no started_at is a contradiction the database should never produce, and it is
// reported as "no elapsed time" rather than silently measured from created_at instead.
export function createNowElapsedMs(status: CreativeJobStatus, timing: CreateNowJobTiming): number | null {
  const since = status === "queued" ? timing.createdAt : status === "running" ? timing.startedAt : "";
  if (since === "") {
    return null;
  }
  const startedMs = Date.parse(since);
  if (!Number.isFinite(startedMs)) {
    return null;
  }
  const elapsedMs = timing.nowMs - startedMs;
  return elapsedMs >= 0 ? elapsedMs : null;
}

// AH1 §15 -- queued and running are two different sentences, and the queued one never claims that
// anything is being made. "Starting shortly" is a promise about the future; "Creating your content"
// is a claim about the present, and saying the second one over a job with started_at = null is the
// precise lie owner testing caught.
export const CREATE_NOW_QUEUED_SLOW_HEADLINE = "Still waiting to start.";
// Elapsed time, and nothing beyond it. The only evidence behind this state is
// now - createdAt >= CREATE_NOW_QUEUED_SLOW_MS, which proves the wait is longer than usual and
// proves nothing whatsoever about the machine: a queued job legitimately waits while ANOTHER job is
// generating, because the worker takes one job per run and holds the run lock for the whole
// generation. An earlier draft of this string inferred "content can't be made on this computer right
// now" from queue age alone -- a diagnosis of worker, scheduler or machine health that this module
// has no evidence for, and one that would read as broken every time the owner simply asked for two
// things in a row. Reporting the wait is honest; explaining it is not this screen's to do.
export const CREATE_NOW_QUEUED_SLOW_DETAIL =
  "This is taking longer than usual to start. Nothing is lost — it will start as soon as it can.";
export const CREATE_NOW_RUNNING_SLOW_HEADLINE = "Still creating your content.";
export const CREATE_NOW_RUNNING_SLOW_DETAIL =
  "This one is taking longer than usual. Nothing has gone wrong — you can leave this page while it finishes.";

export function describeCreateNowProgress(status: CreativeJobStatus, timing: CreateNowJobTiming): CreateNowProgress {
  if (status === "completed") {
    return { headline: "Your content is ready.", detail: "", tone: "good", isSettled: true, elapsedLabel: null };
  }
  if (status === "failed") {
    return {
      headline: "We couldn't create this one.",
      detail: "Nothing else is needed from you. Ask again and it will start fresh.",
      tone: "bad",
      isSettled: true,
      elapsedLabel: null,
    };
  }

  const elapsedMs = createNowElapsedMs(status, timing);
  const elapsedLabel = elapsedMs === null ? null : formatCreateNowElapsed(elapsedMs);

  if (status === "running") {
    const isSlow = elapsedMs !== null && elapsedMs >= CREATE_NOW_RUNNING_SLOW_MS;
    return {
      headline: isSlow ? CREATE_NOW_RUNNING_SLOW_HEADLINE : "Creating your content...",
      detail: isSlow ? CREATE_NOW_RUNNING_SLOW_DETAIL : CREATE_NOW_WAITING_DETAIL,
      tone: "info",
      isSettled: false,
      elapsedLabel,
    };
  }

  const isSlow = elapsedMs !== null && elapsedMs >= CREATE_NOW_QUEUED_SLOW_MS;
  return {
    headline: isSlow ? CREATE_NOW_QUEUED_SLOW_HEADLINE : "We've got your request. Starting shortly.",
    detail: isSlow ? CREATE_NOW_QUEUED_SLOW_DETAIL : CREATE_NOW_WAITING_DETAIL,
    tone: "info",
    isSettled: false,
    elapsedLabel,
  };
}

// --- status refresh ----------------------------------------------------------------------------
//
// Polling, not realtime. One job, by id, every few seconds, and only while that job could still
// change. Introducing Supabase Realtime, a websocket or a second worker to watch a single row the
// owner is already looking at would be new infrastructure for no gain.
export const CREATE_NOW_POLL_INTERVAL_MS = 4500;

export function shouldPollCreativeJobStatus(status: CreativeJobStatus): boolean {
  return status === "queued" || status === "running";
}

// How many times a COMPLETED job's package may be looked for before the screen gives up waiting.
// The worker writes the Creative Package a moment after it finishes the job, and "a moment" is not
// guaranteed to land inside a single 4.5-second tick, so one extra look is not enough. Four looks is
// roughly thirteen seconds of grace: long enough to cover a slow write, short enough that a package
// which is genuinely never coming stops being waited for. The bound exists so this can never become
// an indefinite poll -- the count only ever rises, so the loop always terminates.
export const CREATE_NOW_PACKAGE_GRACE_LOOKS = 4;

export type CreateNowRefreshState = {
  // Null means the job has not been read yet -- the first read is still in flight, and the refresh
  // timer has nothing to add to it.
  status: CreativeJobStatus | null;
  hasJobError: boolean;
  hasPackage: boolean;
  hasPackageError: boolean;
  // How many times a completed job's package has already been looked for and not found. Counts
  // looks, not elapsed time, so the bound is deterministic and provable without a clock.
  packageMissCount: number;
};

// The single answer to "should this screen look again?". Kept here rather than inline in the
// component so every stopping condition is provable.
//
// The one non-obvious case: a job that has just completed is still worth looking at again, because
// the worker writes the Creative Package a moment AFTER it finishes the job. Stopping the instant
// the status turns terminal would leave the owner staring at "ready" with nothing rendered under it.
// That grace is BOUNDED by CREATE_NOW_PACKAGE_GRACE_LOOKS. Once the package is in hand, came back
// unreadable, or the grace is spent, there is nothing left worth looking at and refreshing stops for
// good.
export function shouldRefreshCreateNowJob(state: CreateNowRefreshState): boolean {
  if (state.hasJobError || state.status === null) {
    return false;
  }
  if (shouldPollCreativeJobStatus(state.status)) {
    return true;
  }
  return (
    state.status === "completed" &&
    !state.hasPackage &&
    !state.hasPackageError &&
    state.packageMissCount < CREATE_NOW_PACKAGE_GRACE_LOOKS
  );
}

// The honest end of the grace window: the job really did finish, and its package really is not
// readable yet. Says so plainly and points at the one recovery that genuinely works -- reloading,
// which lands back on the same job because the id is in the URL.
export const CREATE_NOW_PACKAGE_PENDING_MESSAGE =
  "This one is taking longer than usual to show up. Refresh the page to look again — nothing is lost.";

// Deliberately NOT "Your content is ready." From the owner's side, content they cannot see is not
// ready, and pairing that headline with "taking longer to show up" is a screen contradicting itself
// in two consecutive sentences. "Ready" describes the job; this screen has to describe what the
// owner actually has.
export const CREATE_NOW_PACKAGE_PENDING_HEADLINE = "Almost there.";

export function hasCreateNowPackageGraceExpired(state: CreateNowRefreshState): boolean {
  return (
    state.status === "completed" &&
    !state.hasPackage &&
    !state.hasPackageError &&
    state.packageMissCount >= CREATE_NOW_PACKAGE_GRACE_LOOKS
  );
}

// What the screen SHOWS, which is not always the job's own progress.
//
// One case diverges, and only one: a completed job whose package never arrived inside the grace
// window. It is reported as still-waiting rather than ready, and in the same calm register as the
// other waiting states -- tone stays "info", because nothing failed. It is settled, though: there is
// nothing left to look for, so "Create another" is offered rather than leaving the owner watching a
// screen that has stopped changing.
export function describeCreateNowScreenProgress(
  status: CreativeJobStatus,
  refresh: CreateNowRefreshState,
  timing: CreateNowJobTiming,
): CreateNowProgress {
  if (hasCreateNowPackageGraceExpired(refresh)) {
    // No elapsed time here on purpose. The job itself finished; what is outstanding is a package
    // write, so a timer counting since created_at or started_at would be measuring the wrong thing
    // and would read as "still generating" next to copy that says the opposite.
    return {
      headline: CREATE_NOW_PACKAGE_PENDING_HEADLINE,
      detail: CREATE_NOW_PACKAGE_PENDING_MESSAGE,
      tone: "info",
      isSettled: true,
      elapsedLabel: null,
    };
  }
  return describeCreateNowProgress(status, timing);
}

// --- current-job recovery ----------------------------------------------------------------------
//
// The active job's id lives in the URL, so a refresh or a revisit lands back on the same job
// instead of losing it. Mirrors resolveInventoryTab's contract exactly: accepts whatever a Next.js
// searchParams value can be and resolves it without the route pre-validating anything.
//
// The UUID shape is checked here rather than trusted, because this value is used as a Postgres uuid
// comparison. A hand-edited "?job=hello" must read as "no active job", not as a database error the
// owner would see as a broken screen.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CREATE_NOW_JOB_SEARCH_PARAM = "job";

export function resolveCreateNowJobId(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && UUID_PATTERN.test(raw.trim()) ? raw.trim() : null;
}
