/**
 * RFC 4180 CSV parser: quoted fields, escaped quotes, commas and newlines inside quotes, CRLF or LF
 * line endings. Returns rows with their 1-based line number and exact source text (for row hashes).
 */
export interface CsvRow {
  line: number;
  fields: string[];
  raw: string;
}

export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let rowStart = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const push = (end: number) => {
    fields.push(field);
    rows.push({ line: rowStartLine, fields, raw: src.slice(rowStart, end) });
    fields = [];
    field = '';
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
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      const end = i;
      if (ch === '\r' && src[i + 1] === '\n') i++;
      push(end);
      line++;
      rowStartLine = line;
      rowStart = i + 1;
    } else field += ch;
  }
  if (inQuotes) throw new Error(`Unterminated quoted field starting on line ${rowStartLine}`);
  if (field.length || fields.length) push(src.length);
  return rows;
}
