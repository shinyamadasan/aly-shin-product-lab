import type React from "react";
import { products } from "@/lib/sample-data";
import { JOURNEY_ENTRY_TYPES } from "@/lib/journal";
import { CONTENT_DRAFT_STATUSES, CONTENT_TYPE_OPTIONS } from "@/lib/content-drafts";

export function ProductSelect({
  includeNoProductOption,
  onChange,
  selectedProductId,
  value,
}: {
  includeNoProductOption?: boolean;
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  selectedProductId?: string;
  value?: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      Product
      <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" name="productId" defaultValue={value ? undefined : selectedProductId} onChange={onChange} value={value}>
        {includeNoProductOption ? <option value="">No product</option> : null}
        {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
      </select>
    </label>
  );
}

// Journey capture (M2B) -- see MARKETING_MODULE.md's "M2B implementation record". Product
// association is optional for Journey entries (equipment, construction, team updates, and
// other moments have no natural product), unlike every other product-scoped form in this app
// (Proof Day, Costing, Tasting), so the "No product" option is opt-in via
// includeNoProductOption rather than added to every ProductSelect caller.

// Renders an extra option for a value this app's current vocabulary doesn't recognize (e.g.
// one written by a future version, or by hand in the database) instead of silently dropping
// it -- a native <select> with a defaultValue matching no <option> shows nothing selected,
// which would look like the field got cleared. Keeping it visible and selected is what lets
// an edit preserve an unknown value unless the operator actually changes it.
export function JourneyTypeSelect({ selectedType }: { selectedType?: string }) {
  const value = selectedType ?? "";
  const isKnownValue = value === "" || JOURNEY_ENTRY_TYPES.some((type) => type.value === value);

  return (
    <label className="grid gap-1 text-sm font-medium">
      Journey type
      <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" defaultValue={value} name="entryType">
        <option value="">Unclassified</option>
        {JOURNEY_ENTRY_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
        {isKnownValue ? null : <option value={value}>{value}</option>}
      </select>
    </label>
  );
}

// Content Studio (M2C2) -- see MARKETING_MODULE.md's "M2C2 implementation record". Same
// unknown-value-preserving pattern as JourneyTypeSelect: content_type/status are both
// open-ended text with no database enum/check, so an unrecognized value (a future app
// version, a hand-edited row) gets its own injected option and stays selected unless the
// operator actually changes it.
export function ContentTypeSelect({ selectedType }: { selectedType?: string }) {
  const value = selectedType || "general";
  const isKnownValue = CONTENT_TYPE_OPTIONS.some((type) => type.value === value);

  return (
    <label className="grid gap-1 text-sm font-medium">
      Content type
      <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" defaultValue={value} name="contentType">
        {CONTENT_TYPE_OPTIONS.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
        {isKnownValue ? null : <option value={value}>{value}</option>}
      </select>
    </label>
  );
}

export function ContentStatusSelect({ selectedStatus }: { selectedStatus?: string }) {
  const value = selectedStatus || "idea";
  const isKnownValue = CONTENT_DRAFT_STATUSES.some((status) => status.value === value);

  return (
    <label className="grid gap-1 text-sm font-medium">
      Status
      <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" defaultValue={value} name="status">
        {CONTENT_DRAFT_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
        {isKnownValue ? null : <option value={value}>{value}</option>}
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
  if (!productId) {
    return "No product";
  }
  return products.find((product) => product.id === productId)?.name ?? productId;
}
