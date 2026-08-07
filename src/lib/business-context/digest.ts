import { sha256Hex } from "../asset-digest.ts";
import type { BusinessContextCoverage, DomainContext, DomainId, Signal } from "./types.ts";

// Deterministic digests over a built context. Two of them, because there are two questions:
//
//   factsDigest   -- has the underlying business data changed?  (this is the one used for
//                    invalidation, and for "is a prior AI answer still grounded?")
//   signalsDigest -- has our deterministic interpretation of that data changed?
//
// Keeping them separate is what stops a tuned threshold from reading as "the business changed".
//
// Both exclude generatedAt by construction: neither function is given it, so it cannot leak in.
//
// Hashing reuses sha256Hex (src/lib/asset-digest.ts), which is documented there as "the one and
// only hash implementation" and is built on globalThis.crypto.subtle so it runs in both Node and
// the browser. It is async, which makes these async too -- acceptable, because the envelope builder
// is already async for its reads. A second, synchronous hash was rejected: one hash, one place.

// JSON.stringify is not stable -- it serialises keys in insertion order, so two structurally
// identical objects built in different orders hash differently. Every object key is sorted here, at
// every depth, so the digest reflects content and nothing else.
//
// `undefined` handling, stated explicitly because the choice is arbitrary and must be pinned:
//   - an object property whose value is undefined is omitted, exactly as JSON.stringify does, so
//     `{ a: 1, b: undefined }` and `{ a: 1 }` produce identical output and identical digests;
//   - an undefined array element becomes null, again matching JSON.stringify, because dropping it
//     would change the array's length and therefore its meaning.
export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${entries.join(",")}}`;
}

// Domains are hashed in a fixed key order for the same reason object keys are: the digest must
// depend on content, not on the order the registry happened to walk.
function sortedDomainIds(domains: Partial<Record<DomainId, DomainContext>>): DomainId[] {
  return (Object.keys(domains) as DomainId[]).sort();
}

async function hash(payload: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(stableStringify(payload)));
}

// Answers exactly one question: has the underlying business data materially changed?
//
// Included, because each is a statement about the data itself:
//   facts       -- the values, and their states (known(0) and unset are different facts)
//   readOutcome -- whether the data could be read at all
//   rowCounts   -- how many rows were seen, included, and omitted
//   sourceAsOf  -- how current the source data is
//   coverage    -- which domains are present, and which are declared absent
//
// Deliberately excluded, because none of them is the business changing:
//   signals        -- a rule firing differently is interpretation, and belongs to signalsDigest
//   adapterVersion -- a code version. Bumping it while every value stays identical must not read
//                     as "the business changed" and discard grounded prior answers.
//   notes          -- explanatory prose about how a value was obtained, not the value
//   generatedAt    -- excluded by construction: this function is never given it
//
// The exclusions matter because factsDigest is the one used for invalidation. Anything that moves
// it invalidates a prior AI answer, so it must move only when the answer could actually be wrong.
export async function buildFactsDigest(input: {
  domains: Partial<Record<DomainId, DomainContext>>;
  coverage: BusinessContextCoverage;
}): Promise<string> {
  const domains = sortedDomainIds(input.domains).map((domainId) => {
    const domain = input.domains[domainId] as DomainContext;
    return {
      domain: domainId,
      readOutcome: domain.readOutcome,
      sourceAsOf: domain.sourceAsOf,
      rowCounts: domain.rowCounts,
      facts: domain.facts,
    };
  });

  return hash({
    coverage: {
      knownDomains: [...input.coverage.knownDomains].sort(),
      present: [...input.coverage.present].sort(),
      // Three-way and antisymmetric, matching stableStringify's own comparator above. A comparator
      // that returns 1 for equal elements leaves ordering implementation-defined, and this repo has
      // already been bitten by exactly that (see portfolio-ranking.ts's dateMade comparator) -- an
      // unstable sort inside a digest would undermine the one property the digest exists to have.
      absent: [...input.coverage.absent].sort((left, right) =>
        left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0,
      ),
    },
    domains,
  });
}

// Every signal in the snapshot regardless of which home it lives in -- domain-scoped signals on
// each DomainContext, plus the cross-domain signals composed onto the envelope. One digest over
// all of them, so "did our reading of the business move?" has a single answer.
export async function buildSignalsDigest(input: {
  domains: Partial<Record<DomainId, DomainContext>>;
  signals: Signal[];
}): Promise<string> {
  const domainSignals = sortedDomainIds(input.domains).map((domainId) => ({
    domain: domainId,
    signals: (input.domains[domainId] as DomainContext).signals,
  }));

  return hash({ domainSignals, crossDomainSignals: input.signals });
}
