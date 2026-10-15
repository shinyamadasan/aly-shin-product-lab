import type { CreativeFormat } from "../creative-formats.ts";
import type { FastModeRenderFormat } from "./creative-spec.ts";

export type FastModeInitialState = {
  productId?: string;
  format?: FastModeRenderFormat;
};

// The package format has already passed the package validator. Product identity comes only
// from its originating job's structured intent, never from the package's prose.
export function packageHandoff(
  creativePackage: { format: CreativeFormat },
  job?: { intent: Record<string, unknown> } | null,
): FastModeInitialState | null {
  if (creativePackage.format !== "carousel" && creativePackage.format !== "reel") return null;
  const productId = job?.intent.productId;
  return {
    ...(typeof productId === "string" && productId.trim() ? { productId: productId.trim() } : {}),
    format: creativePackage.format,
  };
}
