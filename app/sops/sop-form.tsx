import type { Sop, User } from "@/db/schema";
import { WEEKDAYS, type SopTemplate } from "@/lib/sops";
import { Card, input, label, btnBrand } from "../_components/ui";
import { SubmitButton } from "../_components/client-bits";

const TOOLKITS: [string, string][] = [
  ["metaads", "Meta Ads"],
  ["facebook", "Facebook"],
  ["highlevel", "HighLevel"],
  ["gmail", "Gmail"],
  ["googlecalendar", "Calendar"],
  ["googledrive", "Drive"],
  ["googlesheets", "Sheets"],
  ["googledocs", "Docs"],
  ["stripe", "Stripe"],
  ["slack", "Slack"],
];

const LEVELS: [Sop["autonomy"], string][] = [
  ["L0", "Read-only: reports what it finds, changes nothing"],
  ["L1", "Drafts: proposes every change for approval"],
  ["L2", "Updates the OS itself (tasks, drafts); asks before anything external"],
  ["L3", "Full autonomy (owner only)"],
];

export function SopForm({
  action,
  sop,
  template,
  users,
  categories,
  submitLabel,
  isOwner,
  claudeReady,
}: {
  action: (form: FormData) => Promise<void>;
  sop?: Sop;
  template?: SopTemplate;
  users: User[];
  categories: string[];
  submitLabel: string;
  isOwner: boolean;
  claudeReady: boolean;
}) {
  const v = {
    title: sop?.title ?? template?.title ?? "",
    category: sop?.category ?? template?.category ?? "",
    summary: sop?.summary ?? template?.summary ?? "",
    videoUrl: sop?.videoUrl ?? "",
    body: sop?.body ?? template?.body ?? "",
    breakdown: sop?.breakdown ?? "",
    steps: (sop?.steps ?? template?.steps ?? []).join("\n"),
    ownerId: sop?.ownerId ?? "",
    agentEnabled: sop?.agentEnabled ?? !!template,
    schedule: sop?.schedule ?? template?.schedule ?? "manual",
    weekday: sop?.weekday ?? template?.weekday ?? 1,
    monthDay: sop?.monthDay ?? template?.monthDay ?? 1,
    perClient: sop?.perClient ?? template?.perClient ?? false,
    autonomy: sop?.autonomy ?? template?.autonomy ?? "L1",
    toolkits: sop?.toolkits ?? template?.toolkits ?? [],
  };

  return (
    <form action={action} className="space-y-6">
      <Card title="Lesson">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={label} htmlFor="title">Title</label>
            <input id="title" name="title" required defaultValue={v.title} placeholder="e.g. Monday client touchpoint" className={input} />
          </div>
          <div>
            <label className={label} htmlFor="category">Module (category)</label>
            <input id="category" name="category" list="sop-categories" defaultValue={v.category} placeholder="e.g. Client success" className={input} />
            <datalist id="sop-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div>
            <label className={label} htmlFor="ownerId">Owner (responsible person)</label>
            <select id="ownerId" name="ownerId" defaultValue={v.ownerId} className={input}>
              <option value="">Nobody yet</option>
              {users.filter((u) => u.active).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={label} htmlFor="summary">One-line summary</label>
            <input id="summary" name="summary" defaultValue={v.summary} placeholder="What this achieves and when it's used" className={input} />
          </div>
          <div className="sm:col-span-2">
            <label className={label} htmlFor="videoUrl">Loom video link</label>
            <input id="videoUrl" name="videoUrl" type="url" defaultValue={v.videoUrl} placeholder="https://www.loom.com/share/…  (YouTube and Vimeo work too)" className={input} />
          </div>
        </div>
      </Card>

      <Card title="Instructions">
        <div className="space-y-4">
          <div>
            <label className={label} htmlFor="body">Raw SOP: paste notes, a doc, or the Loom transcript</label>
            <textarea id="body" name="body" rows={10} defaultValue={v.body} className={input} placeholder="In Loom: open the video → Transcript → Copy, then paste here. Claude turns it into a clean step-by-step breakdown." />
          </div>
          <div>
            <label className={label} htmlFor="file">Or upload a file (PDF, .txt or .md, up to 4 MB)</label>
            <input id="file" name="file" type="file" accept=".pdf,.txt,.md,.markdown,text/plain,application/pdf" className="block w-full text-sm" />
            {sop?.fileName && (
              <label className="mt-1 flex items-center gap-1.5 text-xs text-black/60">
                <input type="checkbox" name="removeFile" /> Remove the current file ({sop.fileName})
              </label>
            )}
          </div>
          {!sop && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="autoBreakdown" defaultChecked={claudeReady} disabled={!claudeReady} /> Write a clean breakdown with Claude after saving
              {!claudeReady && <span className="text-xs text-black/50">(needs ANTHROPIC_API_KEY)</span>}
            </label>
          )}
          {sop && (
            <div>
              <label className={label} htmlFor="breakdown">Clean breakdown (Markdown)</label>
              <textarea id="breakdown" name="breakdown" rows={12} defaultValue={v.breakdown} className={`${input} font-mono text-xs`} />
            </div>
          )}
          <div>
            <label className={label} htmlFor="steps">Checklist: one step per line</label>
            <textarea id="steps" name="steps" rows={5} defaultValue={v.steps} className={input} />
          </div>
        </div>
      </Card>

      <Card title="Automation: let an agent run this SOP">
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" name="agentEnabled" defaultChecked={v.agentEnabled} /> An agent follows this SOP
          </label>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={label} htmlFor="schedule">When</label>
              <select id="schedule" name="schedule" defaultValue={v.schedule} className={input}>
                <option value="manual">Only when someone presses Run</option>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly, on…</option>
                <option value="monthly">Monthly, on day…</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="weekday">Weekday (weekly)</label>
              <select id="weekday" name="weekday" defaultValue={v.weekday} className={input}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i + 1}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="monthDay">Day of month (monthly)</label>
              <input id="monthDay" name="monthDay" type="number" min={1} max={28} defaultValue={v.monthDay} className={input} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="perClient" defaultChecked={v.perClient} /> Run it once for each active client
          </label>
          <div>
            <label className={label} htmlFor="autonomy">What the agent may do on its own</label>
            <select id="autonomy" name="autonomy" defaultValue={v.autonomy} className={input}>
              {LEVELS.map(([k, l]) => (
                <option key={k} value={k} disabled={k === "L3" && !isOwner && v.autonomy !== "L3"}>
                  {k}: {l}
                </option>
              ))}
            </select>
          </div>
          <fieldset>
            <legend className={label}>Apps it can use (via Composio)</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {TOOLKITS.map(([k, l]) => (
                <label key={k} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="toolkits" value={k} defaultChecked={v.toolkits.includes(k)} /> {l}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-black/50">It always has the 1Media OS database (clients, tasks, reports, payments). Scheduled SOPs start at about 06:30 UTC on the chosen days.</p>
          </fieldset>
        </div>
      </Card>

      <SubmitButton className={btnBrand} pendingText="Saving…">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
