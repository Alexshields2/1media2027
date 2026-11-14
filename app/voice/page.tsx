import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { allUsers, requireUser } from "@/lib/session";
import { canSee } from "@/lib/team";
import { reprocessVoiceNote } from "../actions";
import { Badge, Card, Empty, PageHeader } from "../_components/ui";
import { Markdown } from "../_components/markdown";
import { VoiceRecorder } from "../_components/voice-recorder";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // the update is written in the background after sending

export default async function VoicePage() {
  const me = await requireUser();
  const users = await allUsers();
  const visible = users.filter((u) => canSee(users, me.id, u.id)).map((u) => u.id);
  const [notes, briefs] = await Promise.all([
    db.select().from(schema.voiceNotes).where(inArray(schema.voiceNotes.userId, visible)).orderBy(desc(schema.voiceNotes.createdAt)).limit(30),
    db.select().from(schema.briefings).where(eq(schema.briefings.kind, "voice_update")).orderBy(desc(schema.briefings.createdAt)).limit(60),
  ]);
  const nameOf = (id: number | null) => users.find((u) => u.id === id)?.name ?? "?";
  const claudeReady = !!process.env.ANTHROPIC_API_KEY;

  return (
    <>
      <PageHeader
        title="Voice notes"
        subtitle="Talk through the business for a few minutes. Claude checks what you said against the OS (clients, money, tasks, EODs) and writes a full business update for your manager."
      />
      {!claudeReady && <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">ANTHROPIC_API_KEY isn&rsquo;t set, so notes are saved but no update is written yet.</div>}

      <Card title="New voice note" className="mb-6">
        <VoiceRecorder />
      </Card>

      <div className="space-y-4">
        {notes.length ? (
          notes.map((n) => {
            const update = briefs.find((b) => b.voiceNoteId === n.id);
            return (
              <Card
                key={n.id}
                title={`${nameOf(n.userId)} · ${n.createdAt.toLocaleString("en-IE", { timeZone: "Europe/Dublin", dateStyle: "medium", timeStyle: "short" })}`}
                actions={
                  <span className="flex items-center gap-2">
                    {update?.forUserId && <span className="text-xs text-black/50">for {nameOf(update.forUserId)}</span>}
                    <Badge tone={n.status === "done" ? "green" : n.status === "error" ? "red" : "blue"}>{n.status === "processing" ? "writing update…" : n.status === "done" ? "update ready" : "not processed"}</Badge>
                  </span>
                }
              >
                {update && <Markdown text={update.body} />}
                {!update && n.status === "processing" && <p className="text-sm text-black/50">Claude is writing the update. Refresh in a minute or two.</p>}
                <details className="mt-3 border-t border-black/5 pt-3 text-sm" open={!update}>
                  <summary className="cursor-pointer text-black/50">
                    Transcript ({n.transcript.split(/\s+/).length} words{n.durationSec ? `, ${Math.max(1, Math.round(n.durationSec / 60))} min` : ""})
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-black/70">{n.transcript}</p>
                </details>
                {(n.status === "error" || (n.status === "processing" && Date.now() - n.createdAt.getTime() > 10 * 60_000)) && (
                  <form action={reprocessVoiceNote.bind(null, n.id)} className="mt-3">
                    <button className="text-xs text-brand underline">Try writing the update again</button>
                  </form>
                )}
              </Card>
            );
          })
        ) : (
          <Card>
            <Empty>No voice notes yet.</Empty>
          </Card>
        )}
      </div>
    </>
  );
}
