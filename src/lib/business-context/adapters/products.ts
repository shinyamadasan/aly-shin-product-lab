// The Products domain -- IDENTITY ONLY.
//
// Why this exists at all: 81 of the 87 signals in the golden fixture carry
// `subject: { kind: "product", id }`, and every CostingSnapshot carries a productId, but nothing in
// the envelope could say what any of those ids referred to. Live use made that concrete -- a real
// finding read `[FIN-001] product bd921bd0-3c91-4b91-a67d-6355e2ef2784 -- blocker` and was
// unactionable without going back to the app.
//
// WHY A DOMAIN RATHER THAN A DISPLAY-TIME LOOKUP. A product's name is a business fact, not
// presentation state. Resolving it in the renderer would mean the brief printing a value the
// envelope does not contain (design section 14 rule 13), and would require handing the /context page
// a product lookup map -- the exact thing that surface is built to refuse. Publishing it as a fact
// keeps both of those contracts intact, and keeps the identity available to every consumer rather
// than to one renderer.
//
// WHAT THIS DOMAIN IS NOT. Identity, and nothing else. No catalogue facts, no category or role
// intelligence, no launch or decision logic, no signals, no recommendations. D1's full Products
// domain remains unbuilt. If a fact is not needed to say *which product a finding is about*, it does
// not belong here.
//
// Stable ids stay stable: this domain publishes the id alongside the name and never replaces one
// with the other. A renderer may annotate an id with a name; nothing may substitute it.

import type { ProductRow } from "../../supabase-mappers.ts";
import type { DomainContext, Fact, Provenance, ReadOutcome } from "../types.ts";

export const PRODUCTS_ADAPTER_VERSION = 1;

export type ProductsRows = {
  products: ProductRow[];
};

// The id is a plain scalar because it is the join key and always exists; the name is a Fact because
// its absence is a real, distinguishable state. Same shape as IngredientSnapshot, which likewise
// carries a plain id and name alongside Fact-valued measurements.
export type ProductIdentity = {
  productId: string;
  name: Fact<string>;
};

function source(kind: Provenance["kind"], extra: Partial<Provenance> = {}): Provenance {
  return { kind, table: "products", ...extra };
}

// Three states, because a product with no name is a different fact from a project whose products
// table predates the column, which is different again from a real name.
//
// `products.name` is `not null` in supabase-schema.sql, so the undefined branch should be
// unreachable on any project whose products table exists at all. It is written anyway: the same
// assumption held for costing's utility columns until a live snapshot proved otherwise, and an
// unreachable guard costs one branch.
function nameFact(value: string | undefined): Fact<string> {
  if (value === undefined) {
    return {
      state: "unknown",
      because: "The name column does not exist in this project yet, so no value could be read for it.",
      source: source("entered", { column: "name" }),
    };
  }

  if (value === "") {
    // An empty name is a row that exists and was never named. It is NOT a missing product, and it
    // must not silently become the id: a renderer needs to be able to tell the two apart.
    return { state: "unset", source: source("entered", { column: "name" }) };
  }

  return { state: "known", value, source: source("entered", { column: "name" }) };
}

const FACT_KEYS = ["byProduct", "productCount"] as const;

function degraded(because: string, outcome: ReadOutcome, state: "unavailable" | "not_configured"): DomainContext {
  const fact = { state, because } as Fact<never>;
  return {
    domain: "products",
    adapterVersion: PRODUCTS_ADAPTER_VERSION,
    readOutcome: outcome,
    sourceAsOf: fact,
    rowCounts: { read: 0, included: 0, omitted: 0 },
    facts: Object.fromEntries(FACT_KEYS.map((key) => [key, fact])),
    signals: [],
    notes: [],
  };
}

export function buildProductsDomainContextFromFailure(outcome: Extract<ReadOutcome, { ok: false }>): DomainContext {
  if (outcome.reason === "missing-table") {
    return degraded("The products table does not exist in this project yet.", outcome, "not_configured");
  }
  return degraded(`The Products read failed: ${outcome.message}`, outcome, "unavailable");
}

export function buildProductsDomainContext(rows: ProductsRows): DomainContext {
  // Every product row, unfiltered. An archived or inactive product still owns its identity, and a
  // finding about one has to remain readable -- filtering here would reintroduce the bare-id problem
  // for exactly the products whose history is most likely to be questioned.
  const identities: ProductIdentity[] = rows.products.map((row) => ({
    productId: row.id,
    name: nameFact(row.name),
  }));

  const rootSource: Provenance = source("entered", { rowIds: rows.products.map((row) => row.id) });

  // max(updated_at) across the rows actually read. Unparseable values are ignored rather than
  // allowed to poison the maximum.
  const updatedAts = rows.products
    .map((row) => row.updated_at)
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));

  const sourceAsOf: Fact<string> =
    updatedAts.length === 0
      ? { state: "empty", source: source("entered", { column: "updated_at" }) }
      : {
          state: "known",
          value: updatedAts.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest)),
          source: source("entered", { column: "updated_at" }),
        };

  return {
    domain: "products",
    adapterVersion: PRODUCTS_ADAPTER_VERSION,
    readOutcome: { ok: true },
    sourceAsOf,
    rowCounts: { read: rows.products.length, included: identities.length, omitted: 0 },
    facts: {
      byProduct: identities.length === 0 ? { state: "empty", source: rootSource } : { state: "known", value: identities, source: rootSource },
      productCount: {
        state: "known",
        value: identities.length,
        source: source("derived", { computedBy: "buildProductsDomainContext", inputs: ["products.facts.byProduct"] }),
      },
    },
    // No signals. This domain answers "which product is this?" and asks nothing about the business.
    signals: [],
    notes: [
      "This domain publishes product identity only -- id and name. Category, role, status, decision, publication state and every other catalogue field are deliberately not loaded.",
    ],
  };
}
