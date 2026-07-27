import type { ParsedCsv } from "./csv-parser";

// itemName/quantity/unit/totalPrice/expirationDate are the original flat format (one already-
// combined quantity+unit per row). packageCount/packageSize/packageUnit/unitPrice are the newer
// package format (N packages of a given size @ price per package) -- see resolvePurchaseQuantity
// in purchase-import.ts for how the two are reconciled. Only itemName is required; a CSV can supply
// either quantity+unit OR packageCount+packageSize+packageUnit (or, unusually, both).
export type ColumnField =
  | "itemName"
  | "brand"
  | "quantity"
  | "unit"
  | "totalPrice"
  | "expirationDate"
  | "category"
  | "packageCount"
  | "packageSize"
  | "packageUnit"
  | "unitPrice"
  | "supplier"
  | "receiptNumber"
  | "purchaseDate";
export type ColumnMapping = Partial<Record<ColumnField, string>>;
export type MappedRow = Record<ColumnField, string>;

const REQUIRED_FIELDS: ColumnField[] = ["itemName"];

const HEADER_SYNONYMS: Record<ColumnField, string[]> = {
  itemName: ["item_name", "item", "name", "ingredient", "product", "description"],
  // "brand name" and "brand-name" both normalize to "brand_name" (see normalizeHeader), so a
  // literal "brand name" entry here would be redundant.
  brand: ["brand", "brand_name", "manufacturer"],
  quantity: ["quantity", "qty", "amount"],
  unit: ["unit", "uom"],
  totalPrice: ["total_price", "price", "total", "cost", "amount_php"],
  expirationDate: ["expiration_date", "expiry", "expiry_date", "exp_date", "best_before"],
  category: ["category", "item_category", "type"],
  packageCount: ["package_count", "pack_count", "packages", "qty_packages", "num_packages"],
  packageSize: ["package_size", "pack_size", "size"],
  packageUnit: ["package_unit", "pack_unit", "size_unit"],
  unitPrice: ["unit_price", "price_per_unit", "price_per_package", "pack_price"],
  supplier: ["supplier", "vendor", "supplier_name"],
  receiptNumber: ["receipt_number", "receipt_no", "invoice_number", "invoice_no", "receipt"],
  purchaseDate: ["purchase_date", "date", "date_bought", "receipt_date"],
};

function normalizeHeader(header: string) {
  return header.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

// Only used to auto-detect the mapping -- the operator can always override it. A CSV whose
// headers already match one of these synonyms skips the mapping step entirely (no unnecessary
// friction); anything else falls back to the manual column-mapping UI.
export function suggestColumnMapping(headers: string[]): ColumnMapping {
  const normalizedHeaders = headers.map((header) => ({ original: header, normalized: normalizeHeader(header) }));
  const mapping: ColumnMapping = {};

  (Object.keys(HEADER_SYNONYMS) as ColumnField[]).forEach((field) => {
    const match = normalizedHeaders.find((header) => HEADER_SYNONYMS[field].includes(header.normalized));
    if (match) {
      mapping[field] = match.original;
    }
  });

  return mapping;
}

// itemName is always required. On top of that, at least one full quantity path must be mapped --
// either the flat quantity+unit pair, or the package triple (count+size+unit). Neither alone is
// enough: a lone "unit" or a lone "package_size" can't produce a purchased quantity.
export function isColumnMappingComplete(mapping: ColumnMapping): boolean {
  if (!REQUIRED_FIELDS.every((field) => Boolean(mapping[field]))) {
    return false;
  }
  const hasFlatQuantity = Boolean(mapping.quantity && mapping.unit);
  const hasPackageQuantity = Boolean(mapping.packageCount && mapping.packageSize && mapping.packageUnit);
  return hasFlatQuantity || hasPackageQuantity;
}

export function applyColumnMapping(parsed: ParsedCsv, mapping: ColumnMapping): MappedRow[] {
  const indexByField: Partial<Record<ColumnField, number>> = {};
  (Object.keys(mapping) as ColumnField[]).forEach((field) => {
    const header = mapping[field];
    if (header) {
      indexByField[field] = parsed.headers.indexOf(header);
    }
  });

  function cell(row: string[], field: ColumnField) {
    const index = indexByField[field];
    return index !== undefined && index >= 0 ? (row[index] ?? "").trim() : "";
  }

  return parsed.rows.map((row) => ({
    itemName: cell(row, "itemName"),
    brand: cell(row, "brand"),
    quantity: cell(row, "quantity"),
    unit: cell(row, "unit"),
    totalPrice: cell(row, "totalPrice"),
    expirationDate: cell(row, "expirationDate"),
    category: cell(row, "category"),
    packageCount: cell(row, "packageCount"),
    packageSize: cell(row, "packageSize"),
    packageUnit: cell(row, "packageUnit"),
    unitPrice: cell(row, "unitPrice"),
    supplier: cell(row, "supplier"),
    receiptNumber: cell(row, "receiptNumber"),
    purchaseDate: cell(row, "purchaseDate"),
  }));
}
