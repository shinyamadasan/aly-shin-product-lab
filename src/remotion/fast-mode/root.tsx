import { Composition } from "remotion";

import { ALY_PON_BRAND_TOKENS } from "../../lib/content-studio/brand-tokens.ts";
import { EDITORIAL_COLLAGE_COMPOSITION_ID, MEDIA_ROLES, planEditorialCollageReel, type PreparedCampaign } from "../../lib/content-studio/creative-plan.ts";
import { CREATIVE_OUTPUT_V1 } from "../../lib/content-studio/creative-spec.ts";
import { EditorialCollage } from "./editorial-collage.tsx";

// Content Studio Fast Mode -- its own Remotion registry, separate from src/remotion/root.tsx so the
// warm-open registry the Asset Job worker bundles is untouched.
//
// Size, fps and duration come from the spec via planEditorialCollageReel, never from literals here.
// defaultProps only satisfies registration: it carries no media and is never rendered -- every render
// passes a PreparedCampaign as input props.
const REGISTRATION_ONLY: PreparedCampaign = {
  spec: {
    specVersion: 1,
    product: { id: "registration-only", name: "Registration only" },
    media: MEDIA_ROLES.map((role) => ({
      id: role,
      role,
      mediaType: "photo" as const,
      source: { kind: "fixture" as const, name: "none" },
      provenance: "test_fixture" as const,
      durationSeconds: null,
    })),
    brand: ALY_PON_BRAND_TOKENS,
    offer: { price: { amount: 1, currency: "PHP" }, unit: "-", cta: "-", confirmedByOwner: true },
    content: { purpose: "product_offer", headline: null },
    output: CREATIVE_OUTPUT_V1,
  },
  media: {},
  copy: { headline: 1, offerProductName: 1, offerLine: 1, endProductName: 1, endOfferLine: 1, cta: 1 },
  notForPublishing: true,
};

const defaultPlan = planEditorialCollageReel(REGISTRATION_ONLY.spec);

export function FastModeRoot() {
  return (
    <Composition
      calculateMetadata={({ props }) => {
        const plan = planEditorialCollageReel(props.spec);
        return { width: plan.width, height: plan.height, fps: plan.fps, durationInFrames: plan.durationInFrames };
      }}
      component={EditorialCollage}
      defaultProps={REGISTRATION_ONLY}
      durationInFrames={defaultPlan.durationInFrames}
      fps={defaultPlan.fps}
      height={defaultPlan.height}
      id={EDITORIAL_COLLAGE_COMPOSITION_ID}
      width={defaultPlan.width}
    />
  );
}
