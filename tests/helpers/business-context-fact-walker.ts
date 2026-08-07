import type { Fact, Provenance } from "../../src/lib/business-context/types.ts";

// Shared recursive Fact traversal for the invariant suites.
//
// It exists because the original walkers only visited `domain.facts[key]` and never descended into
// collection-valued facts. That reached 12 of 141 facts in the M1 fixture -- everything interesting
// (every costing metric, reviewedAt, every ingredient snapshot field) lives inside
// `byCosting.value[]` and `byIngredient.value[]` and went unchecked. Twenty-one real provenance
// violations were hiding behind that gap.
//
// Extracted rather than duplicated: two copies of a subtle traversal would eventually disagree, and
// the point of this helper is that both suites walk exactly the same set.

export const FACT_STATES = new Set(["known", "empty", "unset", "unknown", "not_configured", "stale", "unavailable"]);

export type AnyFact = Fact<unknown> & { source?: Provenance; confidence?: string; value?: unknown };

// Structural recognition of the canonical Fact envelope. A Fact always carries a `state` from the
// closed vocabulary, plus either a `source` (every state that has one) or a `because` (the two that
// do not). Requiring both halves keeps an ordinary object that happens to have a `state` string --
// a rule result, a status record -- from being mistaken for a Fact.
export function isFact(value: unknown): value is AnyFact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.state !== "string" || !FACT_STATES.has(candidate.state)) {
    return false;
  }
  return "source" in candidate || "because" in candidate;
}

export type VisitedFact = {
  // Canonical dotted path, e.g. "costing.facts.byCosting.value.0.costPerPiece" -- readable enough
  // to locate the offending fact from a failure message alone.
  path: string;
  fact: AnyFact;
  // 0 for a fact published directly on the domain, 1+ for one nested inside a collection value.
  depth: number;
};

// Walks every canonical Fact reachable from `root`, exactly once, deterministically.
//
//   - recurses through arrays and plain objects, in insertion order, so paths are stable;
//   - descends *into* a Fact's own `value` after visiting it, which is where nested facts live;
//   - never descends into `source`, because Provenance is not a Fact and contains no facts;
//   - guards against cycles with a visited set, so a self-referential structure cannot hang the run.
export function walkFacts(root: unknown, rootPath: string): VisitedFact[] {
  const found: VisitedFact[] = [];
  const seen = new WeakSet<object>();

  const visit = (node: unknown, path: string, depth: number): void => {
    if (typeof node !== "object" || node === null) {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);

    const nodeIsFact = isFact(node);
    if (nodeIsFact) {
      found.push({ path, fact: node, depth });
    }

    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}.${index}`, depth));
      return;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      // Provenance holds strings and string arrays only -- descending would waste the walk and
      // could misread an `inputs` entry as structure.
      if (nodeIsFact && key === "source") {
        continue;
      }
      // A nested fact is one level deeper than the fact whose value contains it.
      visit(child, `${path}.${key}`, nodeIsFact ? depth + 1 : depth);
    }
  };

  visit(root, rootPath, 0);
  return found;
}
