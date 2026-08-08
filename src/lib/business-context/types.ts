// Canonical Business Context Builder type surface. See planning/BUSINESS_CONTEXT_BUILDER_DESIGN.md
// §4 -- this file is that section expressed as types, and deliberately contains no logic beyond
// the two published constants below.
//
// Nothing here reads a clock, a client, or the environment. Every shape is transport-neutral: the
// builder produces a typed object, and rendering it to a prompt is a separate, replaceable stage.

// The envelope's own shape version. Bumped when a top-level BusinessContext field is added,
// removed, or retyped -- never for an additive fact key, a new domain, or a new signal id.
export const CONTEXT_SCHEMA_VERSION = 1;

// The instant PR0's costing_summaries.updated_at fix went live in production
// (deployment dpl_BavYrqYVnRJdx8tkKiEtvp4HTDJv, aliased to aly-shin-product-lab.vercel.app).
//
// This is the production *live* moment, deliberately not the GitHub merge time (18:31:23Z) and not
// the Vercel build-start time (18:31:26.228Z). Cross-checked against Vercel's own record: build
// start + 36s build duration lands within ~2s of this value, and the later of the two readings was
// taken because the safe direction for a reliability boundary is conservative.
//
// What it means, exactly:
//   updated_at >= this  -- the row was written by the fixed path, so it records a real save.
//   updated_at <  this  -- the column carries an insert default that was never maintained. It says
//                          nothing about whether the costing was reviewed, and must never be read
//                          as if it did.
//
// Historical rows are NOT backfilled. `update costing_summaries set updated_at = now()` would
// assert that every costing was reviewed at migration time, which is false for all of them, and
// would erase exactly the uncertainty the `unknown` fact state exists to carry.
export const COSTING_UPDATED_AT_RELIABLE_FROM = "2026-08-07T18:32:04Z";

// --- Provenance ---------------------------------------------------------------------------------

// How strongly a value is evidenced, as a function of provenance kind and sample size -- never a
// number chosen by an author.
export type Confidence = "high" | "medium" | "low";

// kind semantics:
//   entered    -- the owner typed it
//   calculated -- deterministic arithmetic over entered values
//   derived    -- selection or classification over entered values
//   inferred   -- a proxy stands in for the real thing; requires `basis`, forbids confidence "high"
//   static     -- a constant in code or a document
export type ProvenanceKind = "entered" | "calculated" | "derived" | "inferred" | "static";

export type Provenance = {
  kind: ProvenanceKind;
  table?: string;
  column?: string;
  rowIds?: string[];
  // The named function that produced the value, e.g. "getCostingTotals". Required for
  // calculated/derived, so a number can always be traced to the one implementation that owns it.
  computedBy?: string;
  // Fact paths this was computed from. A cross-domain signal's inputs must span >= 2 domains.
  inputs?: string[];
  // Required when kind is "inferred": states plainly what proxy stood in for the real field.
  basis?: string;
};

// --- Facts --------------------------------------------------------------------------------------

// The absence vocabulary. Every fact is present in the output with an explicit state -- there is no
// silently missing key, and `0` is never a stand-in for "we don't know".
//
//   known          -- a real value. A real zero is known(0); zero is a value, never a state.
//   empty          -- the collection exists and has no members. A real business fact.
//   unset          -- the column exists and the owner never filled it (what ""/0 currently erases).
//   unknown        -- computable in principle, but an input is missing or untrustworthy.
//   not_configured -- no data source is wired at all.
//   stale          -- a real value, past its freshness budget. The value is still given so the
//                     consumer can judge for itself.
//   unavailable    -- the read failed; nothing could be determined.
//
// not_configured and unavailable carry no `source` because, by definition, there is no source row.
export type Fact<T> =
  | { state: "known"; value: T; source: Provenance; confidence?: Confidence }
  | { state: "empty"; source: Provenance }
  | { state: "unset"; source: Provenance }
  | { state: "unknown"; because: string; source: Provenance }
  | { state: "not_configured"; because: string }
  | { state: "stale"; value: T; asOf: string; ageDays: number; budgetDays: number; source: Provenance }
  | { state: "unavailable"; because: string };

export type FactState = Fact<unknown>["state"];

// --- Domains ------------------------------------------------------------------------------------

// The design's fourteen domains D1-D14, plus `selling`. Declared in full up front so `coverage` can
// list a domain as declared-absent rather than letting it be silently invisible.
//
// `selling` is appended by S8 rather than inserted, so the existing ids keep their positions. Adding
// a domain is additive and does NOT bump CONTEXT_SCHEMA_VERSION -- see the rule above. It does move
// factsDigest, because that digest deliberately covers `coverage`; a prior answer computed when the
// envelope knew nothing about selling should be invalidated once selling facts exist.
export const DOMAIN_IDS = [
  "products",
  "batches",
  "costing",
  "sellingFormats",
  "tasting",
  "inventory",
  "supplies",
  "equipment",
  "journey",
  "opportunities",
  "creative",
  "brand",
  "readiness",
  "aiReviews",
  "selling",
] as const;
export type DomainId = (typeof DOMAIN_IDS)[number];

// --- Signals ------------------------------------------------------------------------------------

// One signal type. Domain-scoped and cross-domain signals differ only in who produces them and
// where they are published -- never in shape.
//
// Every id M1 can emit is declared here up front. That is what lets the three adapters be built in
// parallel: none of them edits this array, so none of them collides with the others.
//
// Vocabulary rule: a published id is never renamed and never re-meant -- only deprecated. Adding
// one is additive and free; removing or redefining one breaks any dashboard or alert bound to it
// and is a CONTEXT_SCHEMA_VERSION bump.
export const SIGNAL_IDS = [
  // Rule Engine ids, passed through unchanged (src/lib/rule-engine/*.ts).
  "DEV-001", "DEV-002", "DEV-003", "DEV-004", "DEV-005", "DEV-006",
  "FIN-001", "FIN-002", "FIN-003", "FIN-004", "FIN-005", "FIN-006", "FIN-007",
  "LAUNCH-001", "LAUNCH-002", "LAUNCH-003", "LAUNCH-004",
  "PROD-001", "PROD-002", "PROD-003", "PROD-004", "PROD-005",
  "QUAL-001", "QUAL-002", "QUAL-003", "QUAL-004", "QUAL-005",
  "SUP-001", "SUP-002", "SUP-003", "SUP-004",

  // Domain-scoped signals emitted by M1 adapters.
  "inventory.outOfStock",
  "inventory.expiring",
  "inventory.flagged",

  // Cross-domain signals emitted by composers.
  "costing.staleVsPurchases",
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];

export type SignalSeverity = "blocker" | "warning" | "info";

// Maps 1:1 from the Rule Engine's RuleResult.passed: true -> pass, false -> fail,
// null -> insufficient_data. `null` there means insufficient data, never a guessed failure.
export type SignalStatus = "pass" | "fail" | "insufficient_data";

// What a signal is *about*, as opposed to which domain emitted it. A dashboard grouping by product
// and an alert firing on one ingredient both need this; `domain` cannot answer either.
export type SignalSubject = {
  kind: "product" | "ingredient" | "costing" | "business";
  id: string;
};

export type Signal = {
  id: SignalId;
  domain: DomainId | "cross-domain";
  scope: "domain" | "cross-domain";
  subject?: SignalSubject;
  severity: SignalSeverity;
  status: SignalStatus;
  message: string;
  recommendation: string;
  provenance: Provenance;
};

// --- Domain context -----------------------------------------------------------------------------

// A failed read never aborts the build. The domain reports the failure, its facts become
// unavailable, and it is listed in coverage.absent -- a snapshot with one unavailable domain is far
// more useful than no snapshot, provided the gap is stated.
export type ReadOutcome =
  | { ok: true }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

export type DomainContext = {
  domain: DomainId;
  adapterVersion: number;
  readOutcome: ReadOutcome;
  sourceAsOf: Fact<string>;
  rowCounts: { read: number; included: number; omitted: number };
  facts: Record<string, Fact<unknown>>;
  // scope: "domain" only. Cross-domain signals live on BusinessContext.signals; one signal has
  // exactly one home, decided by who produced it.
  signals: Signal[];
  // Model-generated text, quarantined. Never inside `facts`, never cited as evidence or provenance:
  // an AI that reads its own earlier output as fact compounds error invisibly.
  aiGenerated?: Record<string, unknown>;
  // Honest caveats in plain language -- e.g. that a value was parsed out of a free-text field, or
  // that a category reports insufficient_data because of milestone scope rather than the business.
  notes: string[];
};

// --- Top-level envelope -------------------------------------------------------------------------

export type BusinessContextCoverage = {
  knownDomains: DomainId[];
  present: DomainId[];
  absent: Array<{ domain: DomainId; reason: string }>;
};

export type BusinessContextDataSource = "supabase" | "sample" | "localStorage";

export type BusinessContext = {
  contextSchemaVersion: number;
  // When the builder ran, from the injected clock. Excluded from both digests by construction.
  generatedAt: string;
  // Explicit, never inferred.
  timezone: string;
  // YYYY-MM-DD in `timezone`. Computed once and threaded to every adapter, so no adapter reads a
  // clock and every day-difference in the snapshot shares one anchor.
  businessDay: string;
  dataSource: BusinessContextDataSource;
  coverage: BusinessContextCoverage;
  // Partial by design: only built domains appear. Everything else is declared in coverage.absent
  // with a reason, which is what makes "the builder didn't know about this" distinguishable from
  // "there is nothing there".
  domains: Partial<Record<DomainId, DomainContext>>;
  // Cross-domain composed signals only (scope: "cross-domain").
  signals: Signal[];
  // Two digests, because there are two questions. Both exclude generatedAt, so two builds over
  // unchanged data produce identical values.
  //   factsDigest   -- has the underlying business data changed? (used for invalidation)
  //   signalsDigest -- has our deterministic interpretation of that data changed?
  // A single combined digest was rejected: tuning a threshold would change it while no business
  // data had moved, silently invalidating grounded prior answers for no reason.
  factsDigest: string;
  signalsDigest: string;
};

// --- Build environment and stage contracts ------------------------------------------------------

// Freshness budgets, keyed by a documented name, in days. M1 introduces none: its only composed
// signal is a pure timestamp comparison with no threshold. Ownership of thresholds is an open
// owner decision, and this stays empty until it is answered.
export type Budgets = Record<string, number>;

export type BuildEnv = {
  now: number;
  timezone: string;
  businessDay: string;
  budgets: Budgets;
};

export type ReadResult<TRows> =
  | { ok: true; rows: TRows }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

// Impure, at the edge. The only stage permitted to hold a client or perform I/O.
export type DomainReader<TClient, TRows> = (client: TClient, env: BuildEnv) => Promise<ReadResult<TRows>>;

// Pure. Same (rows, env) always produces the same DomainContext. Reads only its own domain's rows,
// never another domain's tables, and never a clock -- `now` and `businessDay` arrive via env.
export type DomainAdapter<TRows> = (rows: TRows, env: BuildEnv) => DomainContext;

// Pure. Receives finished domain contexts and may read only their published facts and signals --
// never a raw row, never a client, never a clock. If a composer needs a value no adapter publishes,
// the fix is to publish that fact from the owning adapter, not to widen the composer's reach.
//
// The absence of a client parameter is the enforcement: this stage is never given the means to
// read a row, not merely told not to.
export type SignalComposer = (
  domains: Readonly<Partial<Record<DomainId, DomainContext>>>,
  env: BuildEnv,
) => Signal[];

// Registry entries. The envelope builder walks these; adding a module means adding one entry, and
// the builder itself is not modified. knownDomains derives from the domain registry, which is what
// makes a domain with no adapter show up as declared-absent rather than silently missing.
export type DomainRegistration<TClient = unknown, TRows = unknown> = {
  domain: DomainId;
  version: number;
  read: DomainReader<TClient, TRows>;
  build: DomainAdapter<TRows>;
};

export type ComposerRegistration = {
  composerId: string;
  version: number;
  compose: SignalComposer;
};
