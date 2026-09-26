import ProductLab from "../product-lab";

// Orders Workspace V1 merged the old ?tab=orders/?tab=summary views into one page, so there is no
// tab param left to resolve here. A stale /orders?tab=summary bookmark still lands on this same
// unified route -- the query string is simply unread, which Next.js treats as a no-op rather than
// an error.
//
// `?new=1` is resolved server-side exactly like Today's `?job=<id>` (see resolveCreateNowJobId) --
// a plain query param, not client-side cross-page state, so Dashboard's mobile "New order" quick
// action can open this page's own existing New Order form directly.
export default async function OrdersPageRoute({ searchParams }: { searchParams: Promise<{ new?: string | string[] }> }) {
  const { new: openNewOrder } = await searchParams;
  return <ProductLab initialIsCreatingOrder={openNewOrder === "1"} view="orders" />;
}
