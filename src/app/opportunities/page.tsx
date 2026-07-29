import ProductLab from "../product-lab";
import { resolveOpportunityStatusFilter } from "@/lib/opportunity-review";

export default async function OpportunitiesPageRoute({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  const { status } = await searchParams;
  return <ProductLab initialOpportunityStatusFilter={resolveOpportunityStatusFilter(status)} view="opportunities" />;
}
