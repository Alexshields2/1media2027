import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Client, Report } from "../db/schema";
import { eur } from "./dates";
import { periodFor, type Metrics } from "./report-metrics";

// Month-end report PDF, built in pure JS (pdf-lib) so it runs on Vercel without a browser.

const NAVY = rgb(0.008, 0.024, 0.09); // #020617
const PANEL = rgb(0.024, 0.067, 0.149); // #061126
const BLUE = rgb(0.016, 0.6, 0.949); // #0499f2
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.86, 0.88, 0.91);

const W = 595.28; // A4
const H = 841.89;
const M = 48;

export interface WeekRow extends Partial<Metrics> {
  period: string;
}

/** Helvetica only covers WinAnsi: swap common Unicode punctuation and drop anything else it can't draw. */
export function pdfSafe(text: string, font: PDFFont): string {
  const mapped = text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒−]/g, "-")
    .replace(/ | /g, " ")
    .replace(/\t/g, "  ");
  const charset = new Set(font.getCharacterSet());
  return Array.from(mapped)
    .filter((ch) => charset.has(ch.codePointAt(0)!))
    .join("");
}

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(
    private doc: PDFDocument,
    private font: PDFFont,
    private bold: PDFFont,
    private footer: string,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pages.push(this.page);
    this.y = H - M;
  }
  ensure(h: number) {
    if (this.y - h < M + 24) this.newPage();
  }
  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= width) line = next;
        else {
          if (line) out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  }
  text(raw: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}) {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? this.bold : this.font;
    const indent = opts.indent ?? 0;
    const lines = this.wrap(pdfSafe(raw, font), font, size, W - 2 * M - indent);
    const lh = size * 1.45;
    for (const l of lines) {
      this.ensure(lh);
      this.page.drawText(l, { x: M + indent, y: this.y - size, size, font, color: opts.color ?? INK });
      this.y -= lh;
    }
    this.y -= opts.gap ?? 0;
  }
  finish() {
    const n = this.pages.length;
    this.pages.forEach((p, i) => {
      p.drawLine({ start: { x: M, y: M }, end: { x: W - M, y: M }, thickness: 0.5, color: LINE });
      p.drawText(pdfSafe(this.footer, this.font), { x: M, y: M - 14, size: 8, font: this.font, color: MUTED });
      const label = `Page ${i + 1} of ${n}`;
      p.drawText(label, { x: W - M - this.font.widthOfTextAtSize(label, 8), y: M - 14, size: 8, font: this.font, color: MUTED });
    });
  }
}

/** Renders the report body: "#" headings, "-" bullets, **bold** markers removed. */
function drawBody(w: Writer, body: string, skipTitleLines: boolean) {
  let lines = body.replace(/\r\n/g, "\n").split("\n");
  // The header band already shows client, title and period, so drop the report's own title block.
  if (skipTitleLines) {
    const firstSection = lines.findIndex((l) => /^#{2,}\s/.test(l));
    if (firstSection > 0) lines = lines.slice(firstSection);
  }
  for (const raw of lines) {
    const line = raw.trimEnd();
    const clean = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
    if (!line.trim()) {
      w.y -= 5;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      w.y -= level <= 2 ? 8 : 4;
      w.ensure(40);
      w.text(clean(h[2]), { size: level <= 2 ? 14 : 11.5, bold: true, color: level <= 2 ? BLUE : INK, gap: 2 });
      continue;
    }
    const b = line.match(/^\s*[-*•]\s+(.*)$/);
    if (b) {
      w.text(`•  ${clean(b[1])}`, { indent: 10 });
      continue;
    }
    const whole = line.match(/^\*\*(.+)\*\*$/);
    w.text(clean(line), { bold: !!whole });
  }
}

export async function monthlyReportPdf(input: { client: Pick<Client, "name" | "reportCurrency" | "cplTarget">; report: Pick<Report, "kind" | "period" | "body"> & Partial<Metrics>; weeks?: WeekRow[] }): Promise<Uint8Array> {
  const { client, report } = input;
  const cur = client.reportCurrency;
  const p = periodFor(report.kind, report.period);
  const doc = await PDFDocument.create();
  doc.setTitle(`${client.name} – ${report.kind === "monthly" ? "Monthly report" : "Weekly report"} ${p.label}`);
  doc.setAuthor("1Media");
  doc.setProducer("1Media OS");
  doc.setCreationDate(new Date());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold, `Prepared by 1Media · ${client.name} · ${p.label}`);

  // Header band
  const bandH = 128;
  w.page.drawRectangle({ x: 0, y: H - bandH, width: W, height: bandH, color: NAVY });
  w.page.drawRectangle({ x: 0, y: H - bandH, width: W, height: 3, color: BLUE });
  w.page.drawText("1Media", { x: M, y: H - 44, size: 15, font: bold, color: BLUE });
  w.page.drawText(pdfSafe(client.name, bold), { x: M, y: H - 78, size: 22, font: bold, color: rgb(0.93, 0.96, 0.98) });
  const sub = report.kind === "monthly" ? `Monthly Performance Report · ${p.label}` : `Weekly Report · ${p.label}`;
  w.page.drawText(pdfSafe(sub, font), { x: M, y: H - 100, size: 11, font, color: rgb(0.7, 0.78, 0.87) });
  w.y = H - bandH - 26;

  // Metric tiles: 3 x 2
  const tiles: [string, string, string?][] = [
    ["Amount spent", eur(report.spend, cur)],
    ["Leads", report.leads != null ? report.leads.toLocaleString("en-IE") : "–"],
    ["Cost per lead", eur(report.cpl, cur), client.cplTarget != null ? `Target ${eur(client.cplTarget, cur)}` : undefined],
    ["Impressions", report.impressions != null ? report.impressions.toLocaleString("en-IE") : "–"],
    ["Link clicks", report.clicks != null ? report.clicks.toLocaleString("en-IE") : "–"],
    ["Click-through rate", report.ctr != null ? `${report.ctr.toFixed(2)}%` : "–"],
  ];
  const gap = 10;
  const tw = (W - 2 * M - 2 * gap) / 3;
  const th = 58;
  tiles.forEach(([label, value, hint], i) => {
    const x = M + (i % 3) * (tw + gap);
    const y = w.y - Math.floor(i / 3) * (th + gap) - th;
    w.page.drawRectangle({ x, y, width: tw, height: th, color: rgb(0.965, 0.975, 0.99), borderColor: LINE, borderWidth: 0.75 });
    w.page.drawText(label.toUpperCase(), { x: x + 10, y: y + th - 16, size: 7.5, font: bold, color: MUTED });
    w.page.drawText(pdfSafe(value, bold), { x: x + 10, y: y + 16, size: 17, font: bold, color: INK });
    if (hint) w.page.drawText(pdfSafe(hint, font), { x: x + tw - 10 - font.widthOfTextAtSize(pdfSafe(hint, font), 7.5), y: y + 8, size: 7.5, font, color: MUTED });
  });
  w.y -= 2 * th + gap + 22;

  // Weekly breakdown
  const weeks = (input.weeks ?? []).filter((x) => x.spend != null || x.leads != null);
  if (weeks.length) {
    w.text("Week by week", { size: 11.5, bold: true, gap: 4 });
    const cols = ["Week of", "Spend", "Leads", "CPL", "Impressions", "Clicks"];
    const cw = (W - 2 * M) / cols.length;
    const row = (cells: string[], f: PDFFont, color = INK) => {
      w.ensure(18);
      cells.forEach((c, i) => {
        const t = pdfSafe(c, f);
        const x = i === 0 ? M : M + (i + 1) * cw - f.widthOfTextAtSize(t, 9.5) - 6;
        w.page.drawText(t, { x, y: w.y - 11, size: 9.5, font: f, color });
      });
      w.y -= 17;
      w.page.drawLine({ start: { x: M, y: w.y + 2 }, end: { x: W - M, y: w.y + 2 }, thickness: 0.4, color: LINE });
    };
    row(cols, bold, MUTED);
    for (const wk of weeks) {
      row([periodFor("weekly", wk.period).label, eur(wk.spend, cur), String(wk.leads ?? "–"), eur(wk.cpl, cur), wk.impressions?.toLocaleString("en-IE") ?? "–", wk.clicks?.toLocaleString("en-IE") ?? "–"], font);
    }
    w.y -= 14;
  }

  drawBody(w, report.body, true);
  w.finish();
  return doc.save();
}

export function pdfFileName(clientName: string, kind: "weekly" | "monthly", period: string): string {
  const slug = clientName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug}-${kind === "monthly" ? "Monthly-Report" : "Weekly-Report"}-${period}.pdf`;
}
