import ProductLab from "../product-lab";
import { resolveInventoryTab } from "@/lib/inventory-tabs";

export default async function InventoryPageRoute({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  return <ProductLab initialInventoryTab={resolveInventoryTab(tab)} view="inventory" />;
}
