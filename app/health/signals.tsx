import type { HealthSignalRow } from "@/db/schema";

const DOT: Record<HealthSignalRow["status"], string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
  unknown: "bg-ink/20",
};

/** One line per scored signal: coloured dot, label, the numbers behind it. */
export function SignalList({ signals, compact = false }: { signals: HealthSignalRow[]; compact?: boolean }) {
  return (
    <ul className={compact ? "space-y-0.5 text-xs" : "space-y-1 text-sm"}>
      {signals.map((s) => (
        <li key={s.key} className="flex gap-2">
          <span title={s.status} className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${DOT[s.status]}`} />
          <span>
            <span className={`font-medium ${s.status === "unknown" ? "text-ink/40" : "text-ink/80"}`}>{s.label}:</span>{" "}
            <span className={s.status === "unknown" ? "text-ink/40" : ""}>{s.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
