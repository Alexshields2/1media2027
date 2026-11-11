import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { composio, composioEnabled } from "./composio";

// Uploads a month-end PDF into the client's Google Drive folder through Composio.
// This is an approval-free OS write by design: it only ever puts a file into the
// client's own folder, never shares, sends or deletes anything.

/** Composio Google Drive upload tool and its argument names. */
export const DRIVE_UPLOAD_TOOL = "GOOGLEDRIVE_UPLOAD_FILE";

export type DriveUploader = (args: { tool: string; arguments: Record<string, unknown> }) => Promise<unknown>;

export type DriveResult = { status: "uploaded"; fileId: string | null; url: string | null } | { status: "skipped"; reason: string } | { status: "failed"; error: string };

const defaultUploader: DriveUploader = ({ tool, arguments: args }) =>
  composio().tools.execute(tool, { userId: config.composioUserId, arguments: args, dangerouslySkipVersionCheck: true });

/** Finds a file id / link in Composio's response, whatever nesting it uses. */
export function driveFileFromResponse(res: unknown): { fileId: string | null; url: string | null } {
  let fileId: string | null = null;
  let url: string | null = null;
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 5) return;
    const o = v as Record<string, unknown>;
    if (!fileId && typeof o.id === "string") fileId = o.id;
    if (!url && typeof o.webViewLink === "string") url = o.webViewLink;
    for (const k of ["data", "response_data", "file", "result"]) walk(o[k], depth + 1);
  };
  walk(res, 0);
  if (!url && fileId) url = `https://drive.google.com/file/d/${fileId}/view`;
  return { fileId, url };
}

export async function uploadPdfToDrive(
  opts: { folderId: string | null | undefined; fileName: string; bytes: Uint8Array },
  uploader?: DriveUploader,
): Promise<DriveResult> {
  if (!opts.folderId) return { status: "skipped", reason: "No Drive folder on the client record." };
  if (!uploader && !composioEnabled()) return { status: "skipped", reason: "Composio is not connected." };
  const dir = await mkdtemp(join(tmpdir(), "om-pdf-"));
  const path = join(dir, opts.fileName);
  try {
    await writeFile(path, opts.bytes);
    // Composio uploads a local path given for a file field, then calls Drive.
    const res = (await (uploader ?? defaultUploader)({
      tool: DRIVE_UPLOAD_TOOL,
      arguments: { file_to_upload: path, folder_to_upload_to: opts.folderId },
    })) as { successful?: boolean; error?: string | null } | undefined;
    if (res && res.successful === false) return { status: "failed", error: res.error || "Drive upload failed." };
    return { status: "uploaded", ...driveFileFromResponse(res) };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
