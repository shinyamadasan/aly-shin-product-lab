import { buildFactsDigest, buildSignalsDigest } from "./digest.ts";
import {
  ADAPTER_NOT_BUILT_REASON,
  KNOWN_DOMAIN_IDS,
  M1_DOMAIN_BUILDERS,
  M1_DOMAIN_IDS,
  type M1DomainId,
  type M1DomainRows,
} from "./registry.ts";
import { CONTEXT_SCHEMA_VERSION } from "./types.ts";
import type {
  BusinessContext,
  BusinessContextCoverage,
  BusinessContextDataSource,
  BuildEnv,
  DomainContext,
  DomainId,
  ReadResult,
  Signal,
  SignalComposer,
} from "./types.ts";

// Assembles the canonical BusinessContext from whatever the registered domains produced.
//
// Reading happens before this function is called: the caller supplies each domain's ReadResult,
// which is what keeps this module pure, testable against fixtures, and free of any client. That
// separation is also why a failed read can be represented faithfully here rather than thrown away.
//
// Nothing is cached. A snapshot is generated on demand, because a cached business snapshot is one
// whose staleness is invisible.

// What the caller hands over: per-domain read outcomes, already performed at the edge.
export type M1DomainReadResults = {
  [K in M1DomainId]: ReadResult<M1DomainRows[K]>;
};

export type BuildBusinessContextInput = {
  reads: M1DomainReadResults;
  env: BuildEnv;
  dataSource: BusinessContextDataSource;
  // Registered composers, run after every domain context exists. Empty is valid: the envelope is
  // still complete, it simply carries no cross-domain signals.
  composers?: SignalComposer[];
};

function buildDomain<K extends M1DomainId>(domain: K, read: ReadResult<M1DomainRows[K]>, env: BuildEnv): DomainContext {
  const builder = M1_DOMAIN_BUILDERS[domain];

  // A failed read never aborts the build. The domain reports the failure, its facts become
  // unavailable (or not_configured for a missing table), and it is listed in coverage.absent.
  // A snapshot with two healthy domains and one unavailable is far more useful than no snapshot --
  // provided the gap is stated rather than silently rendered as an empty business.
  if (!read.ok) {
    return (builder.buildFromFailure as (outcome: typeof read) => DomainContext)(read);
  }

  return (builder.build as (rows: M1DomainRows[K], env: BuildEnv) => DomainContext)(read.rows, env);
}

function buildCoverage(domains: Partial<Record<DomainId, DomainContext>>): BusinessContextCoverage {
  const present: DomainId[] = [];
  const absent: Array<{ domain: DomainId; reason: string }> = [];

  for (const domain of KNOWN_DOMAIN_IDS) {
    const built = domains[domain];

    if (!built) {
      // Declared, but no adapter exists yet. Stated explicitly so "the builder does not know about
      // this domain" stays distinguishable from "there is nothing there".
      absent.push({ domain, reason: ADAPTER_NOT_BUILT_REASON });
      continue;
    }

    if (built.readOutcome.ok) {
      present.push(domain);
    } else {
      // Built, but its read failed. Present in `domains` with its facts unavailable, and also named
      // here with the real reason -- never quietly dropped.
      absent.push({ domain, reason: built.readOutcome.message });
    }
  }

  return { knownDomains: [...KNOWN_DOMAIN_IDS], present, absent };
}

export async function buildBusinessContext(input: BuildBusinessContextInput): Promise<BusinessContext> {
  const { env } = input;

  const domains: Partial<Record<DomainId, DomainContext>> = {};
  for (const domain of M1_DOMAIN_IDS) {
    domains[domain] = buildDomain(domain, input.reads[domain], env);
  }

  const coverage = buildCoverage(domains);

  // Composers run only after every domain context exists, and receive them frozen: a composer reads
  // published facts, never rows, and never mutates what it was given.
  const signals: Signal[] = [];
  for (const compose of input.composers ?? []) {
    signals.push(...compose(Object.freeze({ ...domains }), env));
  }

  // Digests come from the S2 implementations; no hashing or serialization logic is repeated here.
  // factsDigest deliberately excludes signals, so tuning a rule cannot read as "the business
  // changed". Neither function is given generatedAt, so it cannot leak into either digest.
  const [factsDigest, signalsDigest] = await Promise.all([
    buildFactsDigest({ domains, coverage }),
    buildSignalsDigest({ domains, signals }),
  ]);

  return {
    contextSchemaVersion: CONTEXT_SCHEMA_VERSION,
    // The only value read from the injected clock. Excluded from both digests by construction.
    generatedAt: new Date(env.now).toISOString(),
    timezone: env.timezone,
    businessDay: env.businessDay,
    dataSource: input.dataSource,
    coverage,
    domains,
    signals,
    factsDigest,
    signalsDigest,
  };
}
