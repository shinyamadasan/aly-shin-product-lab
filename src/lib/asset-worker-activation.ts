import { ASSET_KINDS, EXECUTABLE_ASSET_KINDS, type AssetJobWorkerType, type AssetKind } from "./asset-jobs.ts";

// Production MVP Wave C2A -- WHAT THE WORKER RUNTIME MAY EXECUTE, which is deliberately a wider set
// than what the application may ask for.
//
// This module exists because Wave C2A is the first time those two sets differ, and a single set
// could not express the thing C2A was chartered to build:
//
//   the worker knows HOW to execute a short_video
//   the application is NOT yet allowed to ASK it to
//
// THE THREE SETS, and which layer reads each:
//
//   EXECUTABLE_ASSET_KINDS            (asset-jobs.ts)         -- what the APP may queue. Still
//                                                                ["image"]. Unchanged by C2A.
//   EXECUTABLE_ASSET_JOB_WORKER_TYPES (production-route.ts)   -- which workers the APP may name.
//                                                                Still excludes "remotion".
//   the two constants below            (here)                 -- what the WORKER may claim and run.
//
// NOTHING THE APPLICATION CAN REACH MAY IMPORT THIS MODULE. That is not a convention: a test walks
// src/app, src/components and the rest of src/lib and fails if any of them imports it. The moment
// this file becomes reachable from a route or a component, the activation boundary has been crossed
// by accident rather than by decision -- which is exactly the failure C2A is guarding against, since
// C2B's whole job is to cross it deliberately.

// The kinds a worker process may execute. Broader than EXECUTABLE_ASSET_KINDS by exactly one member.
export const ASSET_WORKER_EXECUTABLE_ASSET_KINDS = ["image", "short_video"] as const satisfies readonly AssetKind[];
export type AssetWorkerExecutableAssetKind = (typeof ASSET_WORKER_EXECUTABLE_ASSET_KINDS)[number];

// The workers a worker process may claim. "remotion" is here and deliberately absent from both
// EXECUTABLE_ASSET_JOB_WORKER_TYPES and MACHINE_PRODUCTION_WORKER_TYPES.
export const ASSET_WORKER_EXECUTABLE_WORKER_TYPES = [
  "static_renderer",
  "generative_image",
  "manual_illustration",
  "remotion",
] as const satisfies readonly AssetJobWorkerType[];
export type AssetWorkerExecutableWorkerType = (typeof ASSET_WORKER_EXECUTABLE_WORKER_TYPES)[number];

export function isAssetWorkerExecutableAssetKind(value: string): value is AssetWorkerExecutableAssetKind {
  return (ASSET_WORKER_EXECUTABLE_ASSET_KINDS as readonly string[]).includes(value);
}

export function isAssetWorkerExecutableWorkerType(value: string): value is AssetWorkerExecutableWorkerType {
  return (ASSET_WORKER_EXECUTABLE_WORKER_TYPES as readonly string[]).includes(value);
}

// The claim gate a worker applies before touching a job row. Both halves must hold, mirroring
// isProductionRouteExecutable's own two-part shape -- a runnable worker paired with a kind this
// process cannot produce is still not runnable.
export function isAssetWorkerExecutable(job: { workerType: string; assetKind: string }): boolean {
  return isAssetWorkerExecutableWorkerType(job.workerType) && isAssetWorkerExecutableAssetKind(job.assetKind);
}

// The single sentence this whole module exists to keep true, expressed as data a test can assert
// rather than as a comment a reader has to trust: the worker set STRICTLY CONTAINS the app set, and
// the difference is exactly the capability C2A added and C2B will activate.
export const WORKER_ONLY_ASSET_KINDS: readonly AssetKind[] = ASSET_KINDS.filter(
  (kind) => isAssetWorkerExecutableAssetKind(kind) && !(EXECUTABLE_ASSET_KINDS as readonly string[]).includes(kind),
);
