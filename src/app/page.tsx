import ProductLab from "./product-lab";
import { resolveCreateNowJobId } from "@/lib/create-now";

// `?job=<id>` is how an in-flight creation survives a refresh (Content Creation MVP S4). Resolved
// server-side, exactly like /inventory's tab and /opportunities' status filter, so the route hands
// the app an already-validated value instead of a raw query string.
export default async function Home({ searchParams }: { searchParams: Promise<{ job?: string | string[] }> }) {
  const { job } = await searchParams;
  return <ProductLab initialCreativeJobId={resolveCreateNowJobId(job)} />;
}
