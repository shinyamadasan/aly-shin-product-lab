import {
  buildCostingDomainContext,
  buildCostingDomainContextFromFailure,
  COSTING_ADAPTER_VERSION,
  type CostingRows,
} from "./adapters/costing.ts";
import {
  buildInventoryDomainContext,
  buildInventoryDomainContextFromFailure,
  INVENTORY_ADAPTER_VERSION,
  type InventoryRows,
} from "./adapters/inventory.ts";
import {
  buildReadinessDomainContext,
  buildReadinessDomainContextFromFailure,
  READINESS_ADAPTER_VERSION,
  type ReadinessRows,
} from "./adapters/readiness.ts";
import { DOMAIN_IDS } from "./types.ts";
import type { BuildEnv, DomainContext, DomainId, ReadOutcome } from "./types.ts";

// The static registry the envelope builder walks. Adding a domain means adding one entry here;
// buildBusinessContext itself is never modified.
//
// This is also what makes absence *declared* rather than silent: knownDomains comes from
// DOMAIN_IDS, and any domain without an entry below is reported in coverage.absent with a reason,
// instead of simply not appearing.

// Reading is I/O and belongs to a DomainReader at the edge. The registry deliberately holds only
// the pure half -- given rows, build a context; given a read failure, build the degraded context.
// A reader is supplied by the caller at build time, so this module never touches a client and stays
// browser-safe.
export type DomainBuilder<TRows> = {
  domain: DomainId;
  version: number;
  build: (rows: TRows, env: BuildEnv) => DomainContext;
  buildFromFailure: (outcome: Extract<ReadOutcome, { ok: false }>) => DomainContext;
};

// The row shapes each registered domain expects from its reader.
export type M1DomainRows = {
  costing: CostingRows;
  inventory: InventoryRows;
  readiness: ReadinessRows;
};

export type M1DomainId = keyof M1DomainRows;

export const COSTING_BUILDER: DomainBuilder<CostingRows> = {
  domain: "costing",
  version: COSTING_ADAPTER_VERSION,
  // buildCostingDomainContext takes no env -- every costing fact is an entered value or an
  // arithmetic result. A shorter parameter list is structurally assignable here.
  build: buildCostingDomainContext,
  buildFromFailure: buildCostingDomainContextFromFailure,
};

export const INVENTORY_BUILDER: DomainBuilder<InventoryRows> = {
  domain: "inventory",
  version: INVENTORY_ADAPTER_VERSION,
  build: buildInventoryDomainContext,
  buildFromFailure: buildInventoryDomainContextFromFailure,
};

export const READINESS_BUILDER: DomainBuilder<ReadinessRows> = {
  domain: "readiness",
  version: READINESS_ADAPTER_VERSION,
  build: buildReadinessDomainContext,
  buildFromFailure: buildReadinessDomainContextFromFailure,
};

// The three domains M1 implements. The other eleven are declared in DOMAIN_IDS and reported absent.
export const M1_DOMAIN_BUILDERS = {
  costing: COSTING_BUILDER,
  inventory: INVENTORY_BUILDER,
  readiness: READINESS_BUILDER,
} as const;

export const M1_DOMAIN_IDS: readonly M1DomainId[] = ["costing", "inventory", "readiness"];

// Every domain the registry knows about, in declaration order. Derived from DOMAIN_IDS rather than
// hand-listed, so a domain added to the vocabulary cannot be forgotten here.
export const KNOWN_DOMAIN_IDS: readonly DomainId[] = DOMAIN_IDS;

export const ADAPTER_NOT_BUILT_REASON = "adapter not built yet";
