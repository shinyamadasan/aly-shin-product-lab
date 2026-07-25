// Old standalone inventory routes, consolidated into tabs on /inventory. Kept as redirects (not
// deleted outright) so existing bookmarks and links still land somewhere correct.
export const inventoryRouteRedirects: Array<{ source: string; destination: string; permanent: boolean }> = [
  { source: "/need-to-buy", destination: "/inventory?tab=need-to-buy", permanent: false },
  { source: "/purchase-import", destination: "/inventory?tab=purchases", permanent: false },
  { source: "/inventory-timeline", destination: "/inventory?tab=history", permanent: false },
  { source: "/supplies", destination: "/inventory?tab=purchases", permanent: false },
];
