import type { ParsedCsv } from "./csv-parser";

export type ColumnField = "itemName" | "quantity" | "unit" | "totalPrice" | "expirationDate";
export type ColumnMapping = Partial<Record<ColumnField, string>>;
export type MappedRow = Record<ColumnField, string>;

const REQUIRED_FIELDS: ColumnField[] = ["itemName", "quantity", "unit"];

const HEADER_SYNONYMS: Record<ColumnField, string[]> = {
  itemName: ["item_name", "item", "name", "ingredient", "product", "description"],
  quantity: ["quantity", "qty", "amount"],
  unit: ["unit", "uom"],
  totalPrice: ["total_price", "price", "total", "cost", "amount_php"],
  expirationDate: ["expiration_date", "expiry", "expiry_date", "exp_date", "best_before"],
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

export function isColumnMappingComplete(mapping: ColumnMapping): boolean {
  return REQUIRED_FIELDS.every((field) => Boolean(mapping[field]));
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
    quantity: cell(row, "quantity"),
    unit: cell(row, "unit"),
    totalPrice: cell(row, "totalPrice"),
    expirationDate: cell(row, "expirationDate"),
  }));
}
