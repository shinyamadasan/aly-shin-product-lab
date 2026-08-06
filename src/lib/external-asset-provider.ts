import type { AssetJobExecutor } from "./asset-jobs.ts";
import type { GeneratedAssetFileCandidate } from "./asset-generation-validation.ts";

// The whole "human as provider" decision, in one file -- mirrors manual-text-provider.ts's
// buildManualResultExecutor exactly, one layer down (text -> image). The candidate's bytes have
// already been supplied (browser upload or CLI import) and locally validated before this executor
// is ever invoked. This file makes no network call of any kind -- no fetch, no API key, no SDK --
// it only ever returns a result that already exists.
export function buildExternalAssetExecutor(candidate: GeneratedAssetFileCandidate): AssetJobExecutor {
  return () => [candidate];
}
