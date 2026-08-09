// Runtime v1 PR-3: the internal Business Context surface.
//
// A standalone route that deliberately does NOT go through ProductLab. Every other internal route
// renders <ProductLab view="..." />, which loads all nineteen tables into LabState before showing
// anything; this page needs none of that. It reads through the Business Context runtime, holds no
// LabState, and shares no state with the monolith -- the same independence Orders established.
//
// Unlisted on purpose. It is reachable by typing /context and is not in navItems, because whether a
// deterministic brief is worth permanent sidebar space is a question live use answers, not this PR.
//
// AppShell is rendered by the client component rather than here: app-shell.tsx has no "use client"
// directive and carries onClick handlers, so it is only valid inside the client boundary -- exactly
// how product-lab.tsx already uses it.

import { BusinessContextPage } from "@/components/business-context-page";

export default function BusinessContextRoute() {
  return <BusinessContextPage />;
}
