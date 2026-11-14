"use client";

import { useActionState, useEffect, useState } from "react";
import { generateBreakdown } from "../../actions";

export function BreakdownButton({ id, has, className }: { id: number; has: boolean; className: string }) {
  const [state, action, pending] = useActionState(generateBreakdown.bind(null, id), {});
  return (
    <form action={action} className="inline-flex flex-col items-start gap-1">
      <button disabled={pending} className={className}>
        {pending ? "Claude is writing it… (about a minute)" : has ? "Rewrite breakdown with Claude" : "Write a clean breakdown with Claude"}
      </button>
      {state.error && <span className="text-xs text-red-600">{state.error}</span>}
    </form>
  );
}

/** Ticks are remembered in this browser only; "Mark complete" is what counts as done. */
export function Checklist({ sopId, steps }: { sopId: number; steps: string[] }) {
  const key = `sop-${sopId}-steps`;
  const [checked, setChecked] = useState<boolean[]>(() => steps.map(() => false));
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (Array.isArray(saved)) setChecked(steps.map((_, i) => !!saved[i]));
    } catch {}
  }, [key, steps]);
  const toggle = (i: number) => {
    const next = checked.map((c, j) => (j === i ? !c : c));
    setChecked(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
  };
  const n = checked.filter(Boolean).length;
  return (
    <div>
      <div className="mb-2 text-xs text-black/50">
        {n}/{steps.length} ticked
      </div>
      <ol className="space-y-1.5">
        {steps.map((s, i) => (
          <li key={i}>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="checkbox" checked={checked[i] ?? false} onChange={() => toggle(i)} className="mt-0.5" />
              <span className={checked[i] ? "text-black/40 line-through" : ""}>
                <span className="text-black/40">{i + 1}.</span> {s}
              </span>
            </label>
          </li>
        ))}
      </ol>
    </div>
  );
}
