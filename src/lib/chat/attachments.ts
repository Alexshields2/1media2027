import type Anthropic from "@anthropic-ai/sdk";
import type { ChatAttachment } from "../../db/schema";
import { xlsxToText } from "./xlsx";

// Files attached to a chat message, turned into Messages API content blocks:
//   PDF          -> document block (base64)
//   images       -> image block (base64)
//   CSV/text/JSON -> document block with a plain-text source
//   XLSX         -> each sheet as CSV, in a plain-text document block
// The blocks are saved with the message, so the bytes live in the database (no file storage service).

/** Vercel rejects request bodies over 4.5 MB, so one message carries at most this much. */
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_FILES = 5;
/** Plain text from one file (CSV, sheets) beyond this is refused rather than cut off. */
export const MAX_TEXT_CHARS = 400_000;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xlsx: XLSX,
};

/** What the composer's file picker accepts. */
export const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.csv,.tsv,.txt,.md,.json,.xlsx";

export interface IncomingFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export type AttachmentResult =
  | { ok: true; blocks: Anthropic.Beta.BetaContentBlockParam[]; attachments: ChatAttachment[] }
  | { ok: false; error: string };

/** The media type to trust: the extension wins over the browser's guess (Windows often sends CSV as Excel). */
export function mediaTypeOf(name: string, type: string): string | undefined {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return BY_EXTENSION[ext] ?? (Object.values(BY_EXTENSION).includes(type) ? type : undefined);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Validates the files and turns them into content blocks, or explains what's wrong. */
export function toContentBlocks(files: IncomingFile[]): AttachmentResult {
  if (files.length > MAX_FILES) return { ok: false, error: `Attach at most ${MAX_FILES} files per message.` };
  const total = files.reduce((n, f) => n + f.bytes.byteLength, 0);
  if (total > MAX_TOTAL_BYTES) return { ok: false, error: `Attachments add up to ${mb(total)}; the limit is ${mb(MAX_TOTAL_BYTES)} per message.` };

  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  const attachments: ChatAttachment[] = [];
  for (const f of files) {
    const mediaType = mediaTypeOf(f.name, f.type);
    if (!mediaType) return { ok: false, error: `${f.name}: only PDF, images (PNG, JPG, GIF, WebP), CSV, XLSX and text files can be attached.` };
    if (!f.bytes.byteLength) return { ok: false, error: `${f.name} is empty.` };
    attachments.push({ name: f.name, mediaType, size: f.bytes.byteLength });
    const b64 = () => Buffer.from(f.bytes).toString("base64");

    if (mediaType === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64() }, title: f.name });
    } else if ((IMAGE_TYPES as readonly string[]).includes(mediaType)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: mediaType as ImageType, data: b64() } });
    } else {
      let text: string;
      try {
        text = mediaType === XLSX ? xlsxToText(f.bytes) : new TextDecoder("utf-8").decode(f.bytes);
      } catch (e) {
        return { ok: false, error: `${f.name}: couldn't read it (${e instanceof Error ? e.message : String(e)}).` };
      }
      if (!text.trim()) return { ok: false, error: `${f.name} has no text in it.` };
      if (text.length > MAX_TEXT_CHARS) return { ok: false, error: `${f.name} is too long to send in full (${text.length.toLocaleString("en-IE")} characters; the limit is ${MAX_TEXT_CHARS.toLocaleString("en-IE")}). Split it or remove columns.` };
      blocks.push({ type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: f.name });
    }
  }
  return { ok: true, blocks, attachments };
}

/** Blocks with the file bytes removed, for sending a conversation to the browser. */
export function stripFileData(blocks: unknown[]): unknown[] {
  return blocks.filter((b) => {
    const t = (b as { type?: string }).type;
    return t !== "document" && t !== "image";
  });
}
