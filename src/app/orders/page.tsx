import ProductLab from "../product-lab";
import { resolveOrdersTab } from "@/lib/orders-tabs";

export default async function OrdersPageRoute({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  return <ProductLab initialOrdersTab={resolveOrdersTab(tab)} view="orders" />;
}
