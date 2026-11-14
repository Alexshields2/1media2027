"use client";

import { useActionState, useState } from "react";
import { btnBrand, input, label } from "../../_components/ui";
import type { ProfileFormState } from "../actions";
import { AGENT_ICONS, ChatIcon } from "./agent-icon";

export interface AgentFormValues {
  name: string;
  icon: string;
  description: string;
  instructions: string;
  baseAgent: string;
  toolkits: string[];
  osTools: string[];
  autonomy: "L0" | "L1" | "L2";
  webSearch: boolean;
  ownerOnly: boolean;
  active: boolean;
}

export interface Option {
  value: string;
  label: string;
  hint?: string;
  money?: boolean;
}

const AUTONOMY: { value: AgentFormValues["autonomy"]; label: string; hint: string }[] = [
  { value: "L0", label: "Read-only", hint: "Looks things up. Any change is blocked." },
  { value: "L1", label: "Asks first", hint: "Every change becomes an approval card in the chat." },
  { value: "L2", label: "Updates the OS", hint: "Changes in 1Media OS run; emails, messages and money still need approval." },
];

const TIPS = [
  "Start with who the agent is and the outcome it owns, in one or two sentences.",
  "List the steps it should follow, in order, and which tools to use for each.",
  "Write the rules as plain do's and don'ts (\"Never record a bank payment yourself\").",
  "Say what a good answer looks like: length, format, what to put first.",
  "The house rules (data, safety, tone) are added automatically, so you don't need to repeat them.",
];

export function AgentForm({
  action,
  initial,
  bases,
  toolkits,
  osTools,
  lockOwnerOnly,
  submitLabel,
}: {
  action: (state: ProfileFormState, form: FormData) => Promise<ProfileFormState>;
  initial: AgentFormValues;
  bases: Option[];
  toolkits: Option[];
  osTools: Option[];
  lockOwnerOnly?: boolean;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [icon, setIcon] = useState(initial.icon);
  const [autonomy, setAutonomy] = useState(initial.autonomy);
  const [chars, setChars] = useState(initial.instructions.length);

  return (
    <form action={formAction} className="space-y-6">
      <section className="grid gap-4 rounded-2xl border border-line bg-panel p-4 md:grid-cols-2 md:p-5">
        <div>
          <label className={label} htmlFor="name">
            Name
          </label>
          <input id="name" name="name" required maxLength={60} defaultValue={initial.name} className={input} />
        </div>
        <div>
          <label className={label} htmlFor="description">
            One-line description
          </label>
          <input id="description" name="description" maxLength={200} defaultValue={initial.description} className={input} placeholder="Shown under the name in the agent list" />
        </div>
        <fieldset className="md:col-span-2">
          <legend className={label}>Icon</legend>
          <input type="hidden" name="icon" value={icon} />
          <div className="flex flex-wrap gap-1.5">
            {AGENT_ICONS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setIcon(n)}
                aria-pressed={icon === n}
                aria-label={n}
                className={`grid size-9 place-items-center rounded-xl border ${icon === n ? "border-brand bg-brand-soft text-brand-light" : "border-line text-ink/55 hover:text-ink"}`}
              >
                <ChatIcon name={n} className="size-4.5" />
              </button>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="rounded-2xl border border-line bg-panel p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label className="text-sm font-semibold" htmlFor="instructions">
            Instructions
          </label>
          <span className="num text-xs text-ink/40">{chars.toLocaleString("en-IE")} characters</span>
        </div>
        <p className="mt-1 text-xs text-ink/50">This is the agent&rsquo;s playbook: what it does, how, and its rules. Write it the way you&rsquo;d brief a new hire.</p>
        <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <textarea
            id="instructions"
            name="instructions"
            defaultValue={initial.instructions}
            onChange={(e) => setChars(e.target.value.length)}
            rows={22}
            maxLength={60000}
            spellCheck
            className={`${input} min-h-[360px] font-mono text-[13px] leading-relaxed`}
          />
          <aside className="rounded-xl border border-line bg-canvas/50 p-3 text-xs text-ink/60">
            <p className="mb-2 font-semibold text-ink/80">Tips</p>
            <ul className="space-y-2">
              {TIPS.map((t) => (
                <li key={t} className="flex gap-2">
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-brand-light" />
                  {t}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-ink/40">Markdown headings and lists work well. Changes apply to the next message in every chat with this agent.</p>
          </aside>
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-panel p-4 md:p-5">
        <h2 className="text-sm font-semibold">What it may do</h2>
        <fieldset className="mt-3 grid gap-2 md:grid-cols-3">
          <legend className="sr-only">Autonomy</legend>
          {AUTONOMY.map((a) => (
            <label key={a.value} className={`cursor-pointer rounded-xl border p-3 ${autonomy === a.value ? "border-brand bg-brand-soft" : "border-line hover:border-brand/40"}`}>
              <span className="flex items-center gap-2 text-sm font-medium">
                <input type="radio" name="autonomy" value={a.value} checked={autonomy === a.value} onChange={() => setAutonomy(a.value)} className="accent-[var(--color-brand)]" />
                {a.label} <span className="text-xs font-normal text-ink/40">{a.value}</span>
              </span>
              <span className="mt-1 block text-xs text-ink/55">{a.hint}</span>
            </label>
          ))}
        </fieldset>
        <p className="mt-2 text-xs text-ink/40">Deleting anything, changing Ads Manager, and Stripe refunds or payouts are always blocked.</p>

        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <Checklist title="1Media OS tools" name="osTools" options={osTools} checked={initial.osTools} note="Money tools are hidden from team members in every agent." />
          <div className="space-y-5">
            <Checklist title="Connected apps" name="toolkits" options={toolkits} checked={initial.toolkits} note="Apps are reached through Composio once they're connected (Settings)." />
            <div className="space-y-2">
              <Toggle name="webSearch" checked={initial.webSearch} title="Web search" hint="Let the agent search the web for facts it can't find in the OS." />
              <Toggle name="ownerOnly" checked={lockOwnerOnly || initial.ownerOnly} disabled={lockOwnerOnly} title="Owners only" hint={lockOwnerOnly ? "Payments is always owners only." : "Hide this agent from team members."} />
              <Toggle name="active" checked={initial.active} title="Active" hint="Turned-off agents disappear from the chat list for the team." />
            </div>
            <div>
              <label className={label} htmlFor="baseAgent">
                Based on (optional)
              </label>
              <select id="baseAgent" name="baseAgent" defaultValue={initial.baseAgent} className={input}>
                <option value="">None</option>
                {bases.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink/40">Links a scheduled agent: its safety exclusions (e.g. no sending email directly) and its effort level apply here too.</p>
            </div>
          </div>
        </div>
      </section>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 bg-canvas/90 px-1 py-3 backdrop-blur">
        <button type="submit" disabled={pending} className={btnBrand}>
          {pending ? "Saving…" : submitLabel}
        </button>
        {state.saved && !pending && <span className="text-sm text-emerald-300" role="status">Saved.</span>}
        {state.error && (
          <span className="text-sm text-red-300" role="alert">
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}

function Checklist({ title, name, options, checked, note }: { title: string; name: string; options: Option[]; checked: string[]; note?: string }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium text-ink/60">{title}</legend>
      <div className="max-h-80 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
        {options.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink/[0.04]">
            <input type="checkbox" name={name} value={o.value} defaultChecked={checked.includes(o.value)} className="mt-0.5" />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                {o.label}
                {o.money && <span className="rounded-full bg-amber-500/10 px-1.5 text-[10px] text-amber-300">money</span>}
              </span>
              {o.hint && <span className="block text-xs text-ink/40">{o.hint}</span>}
            </span>
          </label>
        ))}
      </div>
      {note && <p className="mt-1 text-xs text-ink/40">{note}</p>}
    </fieldset>
  );
}

function Toggle({ name, checked, disabled, title, hint }: { name: string; checked: boolean; disabled?: boolean; title: string; hint: string }) {
  return (
    <label className={`flex items-start gap-2.5 rounded-xl border border-line p-3 ${disabled ? "opacity-70" : "cursor-pointer hover:border-brand/40"}`}>
      <input type="checkbox" name={name} defaultChecked={checked} disabled={disabled} className="mt-0.5" />
      {disabled && checked && <input type="hidden" name={name} value="on" />}
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-ink/50">{hint}</span>
      </span>
    </label>
  );
}
