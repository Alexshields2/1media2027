import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { monthlyReportPdf, pdfFileName, pdfSafe } from "../src/lib/report-pdf";
import { driveFileFromResponse, uploadPdfToDrive, DRIVE_UPLOAD_TOOL } from "../src/lib/drive";
import { existsSync, readFileSync } from "node:fs";

const body = [
  "# DEMO PAVING CO",
  "Monthly Digital Marketing Performance Report",
  "Reporting Period: October 2026",
  "",
  "## Executive Summary",
  "October delivered 117 leads at €15.38 – a strong month 🚀 with “smart” quotes.",
  "",
  "## Performance Snapshot",
  "- **Leads:** 117",
  "- **Amount spent:** €1,799.10",
  ...Array.from({ length: 80 }, (_, i) => `- Line ${i + 1} of filler to force a second page`),
].join("\n");

test("month-end PDF renders, paginates and survives non-WinAnsi characters", async () => {
  const bytes = await monthlyReportPdf({
    client: { name: "Demo Paving Co", reportCurrency: "EUR", cplTarget: 15 },
    report: { kind: "monthly", period: "2026-10", body, spend: 1799.1, leads: 117, cpl: 15.38, impressions: 227771, clicks: 3657, ctr: 1.61 },
    weeks: [
      { period: "2026-10-05", spend: 528.1, leads: 42, cpl: 12.57, impressions: 78303, clicks: 1324 },
      { period: "2026-10-12", spend: 258.91, leads: 12, cpl: 21.58, impressions: 29330, clicks: 309 },
    ],
  });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2, "long report spills onto a second page");
  assert.match(doc.getTitle() ?? "", /Demo Paving Co/);
});

test("pdfSafe keeps the euro sign and drops emoji", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  assert.equal(pdfSafe("€10 – ok 🚀 “q” ‘s’", font), "€10 – ok  \"q\" 's'");
});

test("pdf file name", () => {
  assert.equal(pdfFileName("O'Brien Roofing & Sons", "monthly", "2026-10"), "O-Brien-Roofing-Sons-Monthly-Report-2026-10.pdf");
});

test("Drive upload: skipped without a folder, uploads the file to the client folder, reports failures", async () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  assert.deepEqual(await uploadPdfToDrive({ folderId: null, fileName: "a.pdf", bytes }, async () => ({})), { status: "skipped", reason: "No Drive folder on the client record." });
  const prev = process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY;
  assert.equal((await uploadPdfToDrive({ folderId: "f1", fileName: "a.pdf", bytes })).status, "skipped");
  if (prev) process.env.COMPOSIO_API_KEY = prev;

  let seen: { tool: string; arguments: Record<string, unknown> } | undefined;
  let fileExisted = false;
  const ok = await uploadPdfToDrive({ folderId: "folder_123", fileName: "Demo-Monthly-Report-2026-10.pdf", bytes }, async (call) => {
    seen = call;
    const p = String(call.arguments.file_to_upload);
    fileExisted = existsSync(p) && readFileSync(p).length === 4;
    return { successful: true, data: { id: "file_abc", webViewLink: "https://drive.google.com/file/d/file_abc/view" } };
  });
  assert.equal(seen?.tool, DRIVE_UPLOAD_TOOL);
  assert.equal(seen?.arguments.folder_to_upload_to, "folder_123");
  assert.ok(fileExisted, "the PDF is written to a temp file Composio can upload");
  assert.ok(!existsSync(String(seen?.arguments.file_to_upload)), "temp file is cleaned up");
  assert.deepEqual(ok, { status: "uploaded", fileId: "file_abc", url: "https://drive.google.com/file/d/file_abc/view" });

  assert.deepEqual(await uploadPdfToDrive({ folderId: "f", fileName: "a.pdf", bytes }, async () => ({ successful: false, error: "insufficient scope" })), { status: "failed", error: "insufficient scope" });
  assert.equal((await uploadPdfToDrive({ folderId: "f", fileName: "a.pdf", bytes }, async () => Promise.reject(new Error("boom")))).status, "failed");
});

test("Drive response parsing handles nested data", () => {
  assert.deepEqual(driveFileFromResponse({ data: { response_data: { id: "x1" } } }), { fileId: "x1", url: "https://drive.google.com/file/d/x1/view" });
  assert.deepEqual(driveFileFromResponse(undefined), { fileId: null, url: null });
});
