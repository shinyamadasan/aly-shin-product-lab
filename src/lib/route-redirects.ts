// Old standalone inventory routes, consolidated into tabs on /inventory. Kept as redirects (not
// deleted outright) so existing bookmarks and links still land somewhere correct.
export const inventoryRouteRedirects: Array<{ source: string; destination: string; permanent: boolean }> = [
  { source: "/need-to-buy", destination: "/inventory?tab=need-to-buy", permanent: false },
  { source: "/purchase-import", destination: "/inventory?tab=purchases", permanent: false },
  { source: "/inventory-timeline", destination: "/inventory?tab=history", permanent: false },
  { source: "/supplies", destination: "/inventory?tab=purchases", permanent: false },
];

// Dashboard became the home page ("/") and Today moved to /today. Both are temporary (307) on
// purpose: a permanent redirect is cached by the browser indefinitely, and "/" is exactly the
// address that must stay free to change again.
//
// - /dashboard is the old Dashboard address; it now just means home.
// - "/?job=<id>" was Today's resume link before the move. Any bookmark or open tab holding one
//   must still land on the in-flight creation, so a root request that carries a `job` query is
//   forwarded to /today. Query values pass through a Next redirect untouched, so the id survives.
//   A bare "/" carries no job and falls through to the Dashboard.
export const dashboardHomeRedirects: Array<{
  source: string;
  destination: string;
  permanent: boolean;
  has?: Array<{ type: "query"; key: string }>;
}> = [
  { source: "/", destination: "/today", permanent: false, has: [{ type: "query", key: "job" }] },
  { source: "/dashboard", destination: "/", permanent: false },
];
