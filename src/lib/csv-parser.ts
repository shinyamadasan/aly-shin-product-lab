export type ParsedCsv = { headers: string[]; rows: string[][] };

// Dependency-free RFC4180-ish parser: quoted fields, embedded commas/newlines inside quotes,
// "" escaping, and CRLF/CR/LF line endings. No third-party CSV library -- this app has
// deliberately minimal dependencies, and receipt CSVs are simple enough not to need one.
export function parseCsvText(text: string): ParsedCsv {
  const withoutBom = text.replace(/^\uFEFF/, "");
  const normalized = withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];

    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonBlankRows = rows.filter((current) => !(current.length === 1 && current[0].trim() === ""));
  const [headerRow, ...dataRows] = nonBlankRows;

  return {
    headers: (headerRow ?? []).map((header) => header.trim()),
    rows: dataRows,
  };
}

export async function parseCsvFile(file: File): Promise<ParsedCsv> {
  const text = await file.text();
  return parseCsvText(text);
}
