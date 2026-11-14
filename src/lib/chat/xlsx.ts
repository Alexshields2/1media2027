import { inflateRawSync } from "node:zlib";

// A small, dependency-free .xlsx reader: unzips the workbook and turns every sheet into CSV text,
// so spreadsheets can go to the model as plain-text documents. Values only (formulas give their
// cached result); styles, merged cells and charts are ignored.

function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // End of central directory: signature 0x06054b50, searched from the end (comment may follow it).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a valid .xlsx file (zip directory missing)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("not a valid .xlsx file (bad zip entry)");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.(xml|rels)$/.test(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`unsupported zip compression (${method})`);
  }
  return files;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m),
  );
}

/** Concatenated text of every <t> run in an XML fragment. */
function textRuns(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join("");
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

/** "AB12" -> 27 (zero-based column index). */
function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface Sheet {
  name: string;
  rows: string[][];
}

/** Reads every sheet of an .xlsx file. */
export function readXlsx(bytes: Uint8Array): Sheet[] {
  const files = unzip(Buffer.from(bytes));
  const workbook = files.get("xl/workbook.xml")?.toString("utf8");
  if (!workbook) throw new Error("not a valid .xlsx file (no workbook)");
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]));
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));

  return [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const name = decode(attr(m[0], "name") ?? "Sheet");
    const target = targets.get(attr(m[0], "r:id")) ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = files.get(path)?.toString("utf8") ?? "";
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
      const row: string[] = [];
      for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c${c[1]}>`;
        const body = c[2] ?? "";
        const type = attr(tag, "t");
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = textRuns(body);
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else value = v !== undefined ? decode(v) : "";
        const ref = attr(tag, "r");
        const idx = ref ? colIndex(ref) : row.length;
        while (row.length < idx) row.push("");
        row[idx] = value;
      }
      const rowNum = Number(attr(r[0].match(/<row\b[^>]*>/)?.[0] ?? "", "r"));
      while (rowNum && rows.length < rowNum - 1) rows.push([]);
      rows.push(row);
    }
    return { name, rows };
  });
}

/** Every sheet as CSV, each under a "## Sheet: name" heading. */
export function xlsxToText(bytes: Uint8Array): string {
  return readXlsx(bytes)
    .map((s) => `## Sheet: ${s.name}\n${s.rows.map((r) => r.map(csvCell).join(",")).join("\n")}`)
    .join("\n\n");
}
