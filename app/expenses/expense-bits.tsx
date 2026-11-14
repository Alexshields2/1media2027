"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";

/** A category select that saves as soon as it changes (the form's server action does the work). */
export function CategorySelect({ name, defaultValue, options, label, className }: { name: string; defaultValue: string; options: { key: string; label: string }[]; label: string; className: string }) {
  const ref = useRef<HTMLSelectElement>(null);
  return (
    <>
      <select ref={ref} name={name} defaultValue={defaultValue} aria-label={label} className={className} onChange={() => ref.current?.form?.requestSubmit()}>
        {!defaultValue && <option value="">Uncategorised…</option>}
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <Saving />
    </>
  );
}

function Saving() {
  const { pending } = useFormStatus();
  return pending ? <span className="ml-1 text-[11px] text-muted">Saving…</span> : null;
}
