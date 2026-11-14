import { getCurrentUser } from "@/lib/session";
import { getProfile } from "@/lib/chat/profiles";
import { canUseProfile } from "@/lib/chat/access";
import { runChatTurn, type ChatEvent } from "@/lib/chat/engine";
import { MAX_FILES, MAX_TOTAL_BYTES, type IncomingFile } from "@/lib/chat/attachments";

// POST /api/chat: one chat message in, the reply streamed back as newline-delimited JSON
// (see ChatEvent in src/lib/chat/engine.ts). multipart/form-data fields:
//   agent (slug), conversationId?, text?, regenerate? ("1"), files (0..5)

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Vercel stops the function at 300 s: no new model call after 240 s, and cut any call off at 285 s. */
const SOFT_LIMIT_MS = 240_000;
const HARD_LIMIT_MS = 285_000;

function json(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const started = Date.now();
  const user = await getCurrentUser();
  if (!user) return json(401, "Sign in first.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, "Couldn't read the message. If you attached files, keep them under 4 MB in total.");
  }
  const str = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : "");
  const profile = await getProfile(str("agent"));
  if (!profile) return json(404, "That agent doesn't exist.");
  if (!canUseProfile(user.role, profile)) return json(403, `Your account can't use the ${profile.name} agent. Ask an owner.`);

  const blobs = form.getAll("files").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (blobs.length > MAX_FILES) return json(400, `Attach at most ${MAX_FILES} files per message.`);
  if (blobs.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) return json(413, "Attachments are over 4 MB in total.");
  const files: IncomingFile[] = await Promise.all(blobs.map(async (f) => ({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })));
  const conversationId = Number(str("conversationId")) || null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: ChatEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          // the browser went away; the turn still finishes and is saved
        }
      };
      await runChatTurn(
        { user, profile, conversationId, text: str("text"), files, regenerate: str("regenerate") === "1" },
        emit,
        { signal: req.signal, deadline: started + SOFT_LIMIT_MS, hardDeadline: started + HARD_LIMIT_MS },
      );
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
