import { products } from "@/lib/sample-data";

export function ProductSelect({ selectedProductId }: { selectedProductId?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      Product
      <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" name="productId" defaultValue={selectedProductId}>
        {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
      </select>
    </label>
  );
}

export function MediaChecklist({ selectedMedia = "" }: { selectedMedia?: string }) {
  const options = [
    "Texture close-up",
    "Process clip",
    "Final product photo",
    "Packaging photo",
    "Taster reaction",
    "No usable media",
  ];
  const selected = selectedMedia.split(", ").filter(Boolean);

  return (
    <fieldset className="rounded-md border border-[#d8c7b7] p-3">
      <legend className="px-1 text-sm font-medium">Media captured</legend>
      <p className="mb-3 text-xs leading-5 text-[#6f5a4c]">Check only what you actually captured today.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label className="flex items-center gap-2 text-sm" key={option}>
            <input className="h-4 w-4 accent-[#8f5632]" name="mediaCaptured" type="checkbox" value={option} defaultChecked={selected.includes(option)} />
            {option}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function productName(productId: string) {
  return products.find((product) => product.id === productId)?.name ?? productId;
}
