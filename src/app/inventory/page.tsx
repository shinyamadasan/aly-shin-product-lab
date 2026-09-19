import ProductLab from "../product-lab";
import { resolveInventoryFocus, resolveInventoryTab } from "@/lib/inventory-tabs";

export default async function InventoryPageRoute({ searchParams }: { searchParams: Promise<{ tab?: string | string[]; focus?: string | string[] }> }) {
  const { tab, focus } = await searchParams;
  return <ProductLab initialInventoryFocus={resolveInventoryFocus(focus)} initialInventoryTab={resolveInventoryTab(tab)} view="inventory" />;
}
