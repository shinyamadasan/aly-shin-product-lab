import ProductLab from "../product-lab";
import { resolveCreateNowJobId } from "@/lib/create-now";

// Today (the content-creation workflow) lives here; "/" is the operations Dashboard. Nothing about
// Today itself changed when it moved -- only the address.
//
// `?job=<id>` is how an in-flight creation survives a refresh (Content Creation MVP S4). Resolved
// server-side, exactly like /inventory's tab and /opportunities' status filter, so the route hands
// the app an already-validated value instead of a raw query string. Create Now writes the param onto
// whatever URL it is already on, so it follows Today here with no path knowledge of its own; old
// `/?job=<id>` bookmarks are forwarded by dashboardHomeRedirects in src/lib/route-redirects.ts.
export default async function TodayRoute({ searchParams }: { searchParams: Promise<{ job?: string | string[] }> }) {
  const { job } = await searchParams;
  return <ProductLab initialCreativeJobId={resolveCreateNowJobId(job)} view="today" />;
}
