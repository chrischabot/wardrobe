/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF/LF). Returns rows with 1-based line numbers. */
export interface CsvRow {
  /** 1-based physical line on which the record starts. */
  line: number;
  fields: string[];
}

export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let field = "";
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let sawAny = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const endRecord = () => {
    fields.push(field);
    rows.push({ line: recordLine, fields });
    field = "";
    fields = [];
    sawAny = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      sawAny = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      if (sawAny || field !== "" || fields.length > 0) endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
      sawAny = true;
    }
  }
  if (sawAny || field !== "" || fields.length > 0) endRecord();
  return rows;
}
