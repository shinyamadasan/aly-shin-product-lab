import { isCreativeFormat, type CreativeFormat } from "./creative-formats.ts";
import { isCreativeProductionSource } from "./creative-production-guidance.ts";
import type { AssetJobWorkerType, AssetKind } from "./asset-jobs.ts";

// Production MVP Wave A -- the Creative Package -> Production Route translation, in one module.
//
// This answers exactly one question: given a Creative Package, WHICH EXECUTION MECHANISM should
// eventually produce its asset, and WHAT KIND of asset is that. It is the business-specific half of
// Production: no renderer, no provider, no model, no codec -- those belong to the executors this
// route selects, and none of them are named here.
//
// Pure and total by construction, and deliberately in the same discipline as deriveVisualDirection:
// no AI, no clock, no I/O, no database, no environment. The same package always resolves to the
// same route, which is what makes the table below testable as a table rather than as behaviour.
//
// WHY THIS MODULE EXISTS SEPARATELY FROM THE CALL SITE
//
// Route logic scattered across the UI, the worker and the executor is how the three start to
// disagree about what a package means. There is exactly one implementation, here, and every future
// caller reads it rather than re-deriving it.

// The two automated execution mechanisms Production MVP will add, named HERE and not in
// asset-jobs.ts.
//
// That placement is the whole activation boundary, expressed as types rather than as a convention.
// AssetJobWorkerType is the set of workers the runner can actually claim and execute; this wider set
// is what the route table is allowed to WANT. Because the two are different types, a resolved route
// cannot be passed to createAssetJobForReadyCreativePackage without someone first widening
// AssetJobWorkerType -- which is exactly the change that should only ever land alongside a
// registered executor. The compiler enforces what a comment would only request.
// Wave C2A EMPTIES this list, and the empty list is the point rather than a leftover.
//
// Wave A created it to name workers the route table was allowed to WANT but that nothing could
// claim, and "remotion" was its only member. Wave C2A registers the Remotion executor, so
// "remotion" moves into ASSET_JOB_WORKER_TYPES and there is nothing purely-future left.
//
// The concept is kept rather than deleted because the boundary it expresses is still live: the next
// wave that adds a route to a not-yet-built worker puts it here, and the ProductionWorkerType union
// below keeps working unchanged. FutureProductionWorkerType is now `never`, which is exactly the
// truthful statement that no route currently points at an unbuildable worker.
export const FUTURE_PRODUCTION_WORKER_TYPES = [] as const satisfies readonly string[];
export type FutureProductionWorkerType = (typeof FUTURE_PRODUCTION_WORKER_TYPES)[number];

export type ProductionWorkerType = AssetJobWorkerType | FutureProductionWorkerType;

// The MACHINE workers -- the two an owner can ask this app to run, as opposed to "external" (a human
// produced the image elsewhere) and "mock" (tests).
//
// Declared HERE rather than beside the executors on purpose: this module is pure and client-safe,
// while production-asset-executors.ts pulls in satori, resvg and sharp -- native modules that must
// never be reachable from a browser bundle. A client component needs to ask "is this a machine
// route?" without dragging a renderer along with the question.
export const MACHINE_PRODUCTION_WORKER_TYPES = ["static_renderer", "generative_image"] as const;
export type MachineProductionWorkerType = (typeof MACHINE_PRODUCTION_WORKER_TYPES)[number];

export function isMachineProductionWorkerType(value: string): value is MachineProductionWorkerType {
  return (MACHINE_PRODUCTION_WORKER_TYPES as readonly string[]).includes(value);
}

export type ProductionRoute = {
  workerType: ProductionWorkerType;
  assetKind: AssetKind;
};

// --- the desired route table ---------------------------------------------------------------------
//
// FORMAT x PRODUCTION SOURCE -> WORKER TYPE + ASSET KIND, exactly as frozen by the Wave A brief.
//
// Note what this table is NOT: it is not a statement about what the system can execute today. It is
// the intended destination, and Wave A deliberately defines it in full while activating none of the
// rows whose executor does not exist yet. See isProductionRouteExecutable below, and the runtime
// activation boundary that separates the two.
const PRODUCTION_ROUTES: Readonly<Record<string, ProductionRoute>> = {
  "photo:capture_new": { workerType: "external", assetKind: "image" },
  "photo:generate_visual": { workerType: "generative_image", assetKind: "image" },
  "photo:template_only": { workerType: "static_renderer", assetKind: "image" },
  "reel:capture_new": { workerType: "external", assetKind: "short_video" },
  "reel:template_only": { workerType: "remotion", assetKind: "short_video" },
};

// The route every package resolves to when nothing more specific applies.
//
// This is the CURRENT, shipped behaviour of createAssetJobForReadyCreativePackage's only call site
// ("external" + "image"), named once here so the legacy path and the deferred formats cannot drift
// apart from it independently.
export const LEGACY_PRODUCTION_ROUTE: ProductionRoute = { workerType: "external", assetKind: "image" };

// Carousel and Story are deliberately absent from the table above.
//
// Production MVP proves three cases and none of them is a carousel or a story. Inventing an
// automated route for a format nothing will execute would be exactly the "promise the system cannot
// keep" failure the Creative Package validators already exist to prevent -- so both formats resolve
// to the legacy external route and keep behaving precisely as they do today, whatever their
// productionSource says.
const ROUTED_FORMATS: readonly CreativeFormat[] = ["photo", "reel"];

// --- the runtime activation boundary --------------------------------------------------------------
//
// The load-bearing distinction of Wave A.
//
// resolveProductionRoute knows the DESIRED route. The live system can only run the executors that
// are actually registered. Wave A shipped exactly one -- "external", the human/External Creative
// Workspace path. Wave B registers "static_renderer" and "generative_image" in the same change that
// adds them here, which is the rule this boundary exists to enforce. "remotion" is still unregistered
// and arrives in Wave C, and short_video remains unproducible until its executor and storage path
// both exist.
//
// An Asset Job written with a worker_type nothing can claim is not a harmless forward reference --
// it is a queued row that never completes, on a package the owner was told was being produced. That
// is why this is data a caller can ask about rather than only a comment: each wave extends the
// executable set in the same change that registers the executor it names.
//
// isProductionRouteExecutable answers the question for a whole route. The job-creation path needs
// something stronger -- values narrowed to the types it may insert, with no cast in between -- and
// that is toExecutableAssetJobRoute in asset-jobs.ts. The two must always agree; a regression test
// holds them together across the full route table.
//
// "manual_illustration" is executable but is deliberately NOT a destination in the route table
// above. No package resolves to it: it is the owner's explicit fallback CHOICE when the automated
// generative_image route is unavailable, requested by passing options.workerType at job creation --
// the same way the External Creative Workspace panel has always named "external" explicitly. Listing
// it here is what lets that job be created; leaving it out of PRODUCTION_ROUTES is what keeps the
// automated route for a generate_visual package unchanged.
// `as const satisfies` rather than a plain annotation, added in Wave C2A.
//
// `satisfies` keeps the guarantee the annotation gave -- a member that is not a real
// AssetJobWorkerType still fails to compile -- while `as const` preserves the LITERAL types, so
// asset-jobs.ts can derive the app-creatable worker union from this list instead of restating it.
// Before Wave C2A there was no need: AssetJobWorkerType and this list happened to have the same
// members. Registering "remotion" as a claimable worker made them different sets for the first time,
// and the job-creation API must follow this one, not the wider one.
export const EXECUTABLE_ASSET_JOB_WORKER_TYPES = ["external", "mock", "static_renderer", "generative_image", "manual_illustration"] as const satisfies readonly AssetJobWorkerType[];

// Both halves matter. "short_video" has no executor AND no storage path (the bucket still rejects
// video/mp4), so an otherwise-runnable worker paired with it is still not executable today.
export function isProductionRouteExecutable(route: ProductionRoute): boolean {
  return (EXECUTABLE_ASSET_JOB_WORKER_TYPES as readonly string[]).includes(route.workerType) && route.assetKind === "image";
}

// --- resolution -----------------------------------------------------------------------------------

// Total over every supported format x productionSource combination, including the two absences that
// matter:
//
//   1. A package with NO productionSource predates H1-B. Absence is not capture_new and is
//      deliberately not read as one -- it is the absence of the question, and the only honest answer
//      is the behaviour that package was created under. Inferring an automated route from missing
//      historical information would silently re-route content the owner already has.
//
//   2. A v1 package, or anything that is not recognisably v2 content, has no productionSource field
//      at all and takes the same legacy route for the same reason.
// DELIBERATELY STRUCTURAL, not a re-validation.
//
// This reads schemaVersion, format and productionSource and nothing else. It does NOT call
// validateCreativePackageContentV2, and that is a decision worth stating plainly, because the
// obvious-looking alternative is wrong in two ways:
//
//   1. It would couple routing to validation. A future change to an unrelated validation rule --
//      a stricter audioDirection check, say -- would silently re-route packages, which is exactly
//      the kind of action-at-a-distance this codebase avoids elsewhere.
//
//   2. It would make the route table unable to express its own future rows -- and reel +
//      template_only is the worked example. That combination was rejected by the stored contract for
//      three waves after this table froze it; had routing re-validated, the row could never have
//      resolved at all and the table would have had to be edited later, defeating the point of
//      freezing the desired mapping up front. Wave C2B-1 relaxed the stored contract instead, so the
//      row is now reachable from a valid package WITHOUT this module changing by a single character.
//      That is the payoff of keeping routing structural: the table was right early and stayed still.
//
//      Reachable is not executable. The activation boundary below is what still gates it, and
//      broader owner-facing authoring remains later work.
//
// Validation remains where it already is: at generation and at storage. A package that reaches this
// function has been validated by whatever wrote it, and this function's job is the mapping alone.
export function resolveProductionRoute(creativePackage: { content: unknown }): ProductionRoute {
  const content = creativePackage.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return LEGACY_PRODUCTION_ROUTE;
  }

  const candidate = content as { schemaVersion?: unknown; format?: unknown; productionSource?: unknown };

  // A v1 package -- or anything not announcing itself as v2 -- has no productionSource field at all
  // and predates every question Production asks. Legacy route, unchanged behaviour.
  if (candidate.schemaVersion !== "v2") {
    return LEGACY_PRODUCTION_ROUTE;
  }

  // Absence is the pre-H1-B state and is NOT read as capture_new. It is the absence of the question,
  // and the only honest answer is the behaviour the package was created under. Inferring an
  // automated route from missing historical information would silently re-route content the owner
  // already has in hand.
  if (candidate.productionSource === undefined) {
    return LEGACY_PRODUCTION_ROUTE;
  }

  if (!isCreativeFormat(candidate.format) || !isCreativeProductionSource(candidate.productionSource)) {
    return LEGACY_PRODUCTION_ROUTE;
  }

  if (!ROUTED_FORMATS.includes(candidate.format)) {
    return LEGACY_PRODUCTION_ROUTE;
  }

  return PRODUCTION_ROUTES[`${candidate.format}:${candidate.productionSource}`] ?? LEGACY_PRODUCTION_ROUTE;
}
