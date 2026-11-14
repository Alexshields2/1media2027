"use client";

import { useEffect, useMemo, useOptimistic, useRef, useState, useTransition, type ReactNode } from "react";
import { ClientLogo } from "../_components/client-logo";
import { Icon } from "../_components/icons";
import { Badge, Progress, btn, btnGhost, btnSm, field, input, label as labelCls } from "../_components/ui";
import {
  buildPaymentLog,
  byMonth,
  cellState,
  isOverdue,
  METHODS,
  money,
  monthLong,
  monthShort,
  shortDate,
  tickedValues,
  untickedValues,
  type LogClient,
  type LogRow,
  type Method,
} from "@/lib/payment-log-core";
import { assignPaymentAction, editPaymentAction, ignorePaymentAction, tickAction, untickAction, type LogResult } from "./log-actions";

// The payment log: tick a client's month to mark it paid in full, untick to set it back, click the amount for
// a part payment, date, method or note. Ticks show at once (optimistic) and the server's answer replaces them.

type Patch = Record<number, Partial<LogRow>>;

function useLog(rows: LogRow[]) {
  const [optimistic, patch] = useOptimistic<Patch, Patch>({}, (state, p) => ({ ...state, ...p }));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const merged = useMemo(() => rows.map((r) => (optimistic[r.id] ? { ...r, ...optimistic[r.id] } : r)), [rows, optimistic]);

  const run = (p: Patch, action: () => Promise<LogResult>) =>
    start(async () => {
      setError(null);
      patch(p);
      try {
        const r = await action();
        if (!r.ok) setError(r.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't save that. Try again.");
      }
    });
  return { rows: merged, pending, error, setError, run };
}

export interface LogProps {
  mode: "grid" | "list";
  year: number;
  years: number[];
  today: string;
  clients: LogClient[];
  rows: LogRow[];
}

export function PaymentLog({ mode, year, years, today, clients, rows: serverRows }: LogProps) {
  const { rows, error, setError, run } = useLog(serverRows);
  const data = useMemo(() => buildPaymentLog(clients, rows, year, today, years), [clients, rows, year, today, years]);
  const clientOf = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const [editing, setEditing] = useState<LogRow | null>(null);
  const [hover, setHover] = useState<{ row: LogRow; x: number; y: number } | null>(null);

  const toggle = (row: LogRow) => {
    const client = clientOf.get(row.clientId)!;
    const s = cellState(row);
    if (s === "paid") {
      if (!window.confirm(`Mark ${client.name} ${monthLong(row.period)}${row.label !== "Retainer" ? ` (${row.label})` : ""} as unpaid?\n\nThis clears the amount collected (${money(row.amountCollected)}) and the date paid.`)) return;
      run({ [row.id]: { ...untickedValues } }, () => untickAction([row.id]));
    } else {
      run({ [row.id]: tickedValues(row, client, today) }, () => tickAction([row.id]));
    }
  };

  const cellProps: CellHandlers = {
    today,
    onToggle: toggle,
    onEdit: (r) => {
      setHover(null);
      setEditing(r);
    },
    onHover: (row, el) => {
      if (!row || !el) return setHover(null);
      const b = el.getBoundingClientRect();
      setHover({ row, x: b.left + b.width / 2, y: b.bottom });
    },
  };

  return (
    <>
      <Summary data={data} />
      {error && (
        <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="grid size-10 shrink-0 place-items-center rounded-lg text-red-200 hover:bg-red-500/10" aria-label="Dismiss">
            <Icon name="x" />
          </button>
        </div>
      )}
      {mode === "grid" ? <Grid data={data} h={cellProps} /> : <MonthList data={data} h={cellProps} />}
      {hover && <HoverCard row={hover.row} client={clientOf.get(hover.row.clientId)!} x={hover.x} y={hover.y} today={today} />}
      {editing && (
        <Editor
          row={rows.find((r) => r.id === editing.id) ?? editing}
          client={clientOf.get(editing.clientId)!}
          today={today}
          onClose={() => setEditing(null)}
          onSave={(v) => {
            setEditing(null);
            run({ [editing.id]: v }, () => editPaymentAction({ paymentId: editing.id, amountCollected: v.amountCollected, paidDate: v.paidDate, method: v.method, notes: v.notes }));
          }}
        />
      )}
    </>
  );
}

/* ---------- summary strip ---------- */

function Summary({ data }: { data: ReturnType<typeof buildPaymentLog> }) {
  const { collected, outstanding, unpaidMonths, due } = data.summary;
  const label = data.year === Number(data.today.slice(0, 4)) ? "YTD" : String(data.year);
  const tiles: { k: string; v: ReactNode; sub: string; tone?: string }[] = [
    { k: `Collected ${label}`, v: money(collected), sub: `${due ? Math.round((collected / due) * 100) : 0}% of ${money(due)} billed`, tone: "text-emerald-300" },
    { k: `Outstanding ${label}`, v: money(outstanding), sub: "due and not yet paid", tone: outstanding > 0 ? "text-white" : "text-emerald-300" },
    { k: "Unpaid months", v: String(unpaidMonths), sub: unpaidMonths === 1 ? "client-month past due" : "client-months past due", tone: unpaidMonths ? "text-red-300" : "text-emerald-300" },
  ];
  return (
    <section className="surface relative mb-6 overflow-hidden rounded-3xl border border-line bg-panel" aria-label="Year summary">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_120%_at_0%_0%,rgb(4_153_242/0.16),transparent_60%)]" />
      <div className="relative grid grid-cols-3 gap-3 p-4 sm:gap-5 sm:p-6">
        {tiles.map((t) => (
          <div key={t.k} className="min-w-0">
            <div className="text-[10px] font-semibold tracking-[0.12em] text-muted uppercase sm:text-[11px]">{t.k}</div>
            <div className={`num mt-1 text-base font-semibold tracking-tight break-words sm:text-3xl ${t.tone}`}>{t.v}</div>
            <div className="mt-0.5 hidden text-xs text-muted sm:block">{t.sub}</div>
          </div>
        ))}
      </div>
      <Progress value={collected} max={due} tone="green" label={`Collected ${label}`} className="relative mx-4 mb-4 !h-2 sm:mx-6 sm:mb-6" />
    </section>
  );
}

/* ---------- the grid ---------- */

interface CellHandlers {
  today: string;
  onToggle: (row: LogRow) => void;
  onEdit: (row: LogRow) => void;
  onHover: (row: LogRow | null, el: HTMLElement | null) => void;
}

const stickyCol = "sticky left-0 z-10 bg-panel shadow-[1px_0_0_var(--color-line)]";

function Grid({ data, h }: { data: ReturnType<typeof buildPaymentLog>; h: CellHandlers }) {
  const active = data.lines.filter((l) => l.group === "active");
  const paused = data.lines.filter((l) => l.group === "paused");
  const multi = new Set(data.lines.filter((l) => !l.first).map((l) => l.client.id));
  const scroller = useRef<HTMLDivElement>(null);
  // On a phone, open on the latest months (the end of the year so far), not January.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth;
  }, [data.year]);
  if (!data.lines.length) {
    return <p className="rounded-2xl border border-line bg-panel p-8 text-center text-sm text-muted">No payments in {data.year}.</p>;
  }
  const row = (l: (typeof data.lines)[number]) => (
    <tr key={l.key} className={`${l.first ? "border-t border-line/70" : ""} ${l.group === "paused" ? "opacity-70" : ""}`}>
      <th scope="row" className={`${stickyCol} w-36 max-w-36 px-3 py-1.5 text-left font-normal sm:w-56 sm:max-w-56 sm:pl-5`}>
        {l.first ? (
          <a href={`/clients/${l.client.id}`} className="group flex items-center gap-2.5">
            <ClientLogo name={l.client.name} size={30} className="hidden rounded-lg sm:grid" />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-white group-hover:text-brand-light">{l.client.name}</span>
              <span className="block truncate text-[11px] text-muted capitalize">
                {multi.has(l.client.id) ? l.label : l.client.billingMethod}
                {l.client.status !== "active" && ` · ${l.client.status}`}
              </span>
            </span>
          </a>
        ) : (
          <span className="flex items-center gap-1.5 pl-1 text-[12px] text-soft sm:pl-10">
            <span aria-hidden className="text-muted">↳</span>
            <span className="truncate">{l.label}</span>
          </span>
        )}
      </th>
      {data.months.map((m) => (
        <Cell key={m} row={l.cells[m]} h={h} who={`${l.client.name}${l.label !== "Retainer" ? ` ${l.label}` : ""}, ${monthLong(m)}`} />
      ))}
      <td className="px-3 py-1.5 text-right whitespace-nowrap sm:pr-5">
        <div className="num text-[12px] text-white">{money(l.paid)}</div>
        <div className="num text-[11px] text-muted">of {money(l.due)}</div>
        <Progress value={l.paid} max={l.due} tone={l.paid >= l.due - 0.005 ? "green" : "amber"} label={`${l.client.name} paid this year`} className="mt-1 ml-auto w-16 !h-1" />
      </td>
    </tr>
  );
  return (
    <div className="surface overflow-hidden rounded-2xl border border-line bg-panel">
      <div ref={scroller} className="overflow-x-auto overscroll-x-contain" data-testid="payment-grid">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th scope="col" className={`${stickyCol} z-20 border-b border-line px-3 py-2.5 text-left text-[11px] font-semibold tracking-[0.1em] text-muted uppercase sm:pl-5`}>
                Client
              </th>
              {data.months.map((m) => (
                <th key={m} scope="col" className={`border-b border-line px-1 py-2.5 text-center text-[11px] font-semibold tracking-[0.1em] uppercase ${m.slice(0, 7) === data.today.slice(0, 7) ? "text-brand-light" : "text-muted"}`}>
                  {monthShort(m)}
                </th>
              ))}
              <th scope="col" className="border-b border-line px-3 py-2.5 text-right text-[11px] font-semibold tracking-[0.1em] text-muted uppercase sm:pr-5">
                {data.year}
              </th>
            </tr>
          </thead>
          <tbody>
            {active.map(row)}
            {paused.length > 0 && (
              <tr>
                <th scope="rowgroup" colSpan={1} className={`${stickyCol} border-t border-line bg-canvas/80 px-3 py-1.5 text-left text-[10px] font-semibold tracking-[0.12em] text-muted uppercase sm:pl-5`}>
                  Paused / ended
                </th>
                <td colSpan={data.months.length + 1} className="border-t border-line bg-canvas/80" />
              </tr>
            )}
            {paused.map(row)}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className={`${stickyCol} border-t border-line-strong px-3 py-3 text-left text-[11px] font-semibold tracking-[0.1em] text-muted uppercase sm:pl-5`}>
                Collected
              </th>
              {data.columns.map((c) => (
                <td key={c.period} className="border-t border-line-strong px-1.5 py-3 text-center align-top">
                  <div className="num text-[11px] font-medium text-white">{compact(c.collected)}</div>
                  <div className="num text-[10px] text-muted">of {compact(c.due)}</div>
                  <Progress value={c.collected} max={c.due} tone={c.collected >= c.due - 0.005 ? "green" : "brand"} label={`Collected ${monthLong(c.period)}`} className="mx-auto mt-1 w-12 !h-1" />
                </td>
              ))}
              <td className="border-t border-line-strong px-3 py-3 text-right whitespace-nowrap sm:pr-5">
                <div className="num text-[12px] font-semibold text-emerald-300">{money(data.summary.collected)}</div>
                <div className="num text-[11px] text-muted">of {money(data.summary.due)}</div>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Legend />
    </div>
  );
}

const compact = (n: number) => (n >= 10_000 ? `€${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : money(Math.round(n)));

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-4 py-3 text-xs text-muted sm:px-5">
      <span className="flex items-center gap-1.5"><TickBox state="paid" small /> Paid</span>
      <span className="flex items-center gap-1.5"><TickBox state="part" small /> Part paid</span>
      <span className="flex items-center gap-1.5"><TickBox state="unpaid" small /> Unpaid</span>
      <span className="flex items-center gap-1.5"><TickBox state="unpaid" overdue small /> Overdue</span>
      <span className="flex items-center gap-1.5"><span className="w-4 text-center">–</span> Nothing due</span>
      <span className="ml-auto hidden sm:inline">Tick to mark paid in full · click the amount for a part payment, date, method or note</span>
    </div>
  );
}

function TickBox({ state, overdue = false, small = false }: { state: "paid" | "part" | "unpaid"; overdue?: boolean; small?: boolean }) {
  const size = small ? "size-4 rounded" : "size-6 rounded-md";
  if (state === "paid")
    return (
      <span className={`${size} grid place-items-center bg-emerald-400 text-[#022c22] shadow-[0_0_10px_rgb(52_211_153/0.35)]`} aria-hidden>
        <svg viewBox="0 0 24 24" className={small ? "size-3" : "size-4"} fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
    );
  if (state === "part")
    return <span className={`${size} border-2 border-amber-400 bg-[linear-gradient(135deg,var(--color-amber-400)_50%,transparent_50%)]`} aria-hidden />;
  return <span className={`${size} border-2 ${overdue ? "border-red-400 bg-red-500/15" : "border-line-strong bg-canvas"}`} aria-hidden />;
}

function Cell({ row, h, who }: { row: LogRow | undefined; h: CellHandlers; who: string }) {
  const s = cellState(row);
  if (!row || s === "none")
    return (
      <td className="px-1 py-1.5 text-center text-muted/60" aria-label={`${who}: nothing due`}>
        –
      </td>
    );
  const late = isOverdue(row, h.today);
  const stateText = s === "paid" ? "paid" : s === "part" ? `part paid, ${money(row.amountCollected)} of ${money(row.amountDue)}` : late ? "overdue" : "unpaid";
  return (
    <td className={`px-1 py-1.5 ${late ? "bg-red-500/[0.09]" : ""}`} onMouseEnter={(e) => h.onHover(row, e.currentTarget)} onMouseLeave={() => h.onHover(null, null)}>
      <div className="flex flex-col items-center">
        <button
          type="button"
          role="checkbox"
          aria-checked={s === "paid" ? true : s === "part" ? "mixed" : false}
          aria-label={`${who}: ${stateText}`}
          onClick={() => h.onToggle(row)}
          className="grid size-10 place-items-center rounded-lg transition hover:bg-ink/[0.06] focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none active:scale-95"
        >
          <TickBox state={s} overdue={late} />
        </button>
        <button
          type="button"
          onClick={() => h.onEdit(row)}
          aria-label={`Edit ${who}`}
          className={`num -mt-0.5 flex h-10 min-w-14 flex-col items-center justify-start rounded-md px-1 pt-0.5 text-[11px] leading-tight whitespace-nowrap hover:bg-ink/[0.06] focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none ${
            s === "paid" ? "text-soft" : s === "part" ? "text-amber-300" : late ? "text-red-300" : "text-muted"
          }`}
        >
          <span>{s === "part" ? money(row.amountCollected) : compact(row.amountDue)}</span>
          <span className="text-[10px] text-muted">{s === "part" ? `of ${compact(row.amountDue)}` : row.paidDate ? dayMonth(row.paidDate) : late ? "late" : ""}</span>
        </button>
      </div>
    </td>
  );
}

const dayMonth = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IE", { day: "numeric", month: "short", timeZone: "UTC" });

/* ---------- hover card ---------- */

function HoverCard({ row, client, x, y, today }: { row: LogRow; client: LogClient; x: number; y: number; today: string }) {
  const s = cellState(row);
  const late = isOverdue(row, today);
  const left = typeof window === "undefined" ? x : Math.min(Math.max(x, 140), window.innerWidth - 140);
  return (
    <div role="tooltip" className="pointer-events-none fixed z-50 w-64 -translate-x-1/2 rounded-xl border border-line-strong bg-panel-2 p-3 text-xs shadow-2xl" style={{ left, top: y + 6 }}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate font-semibold text-white">{client.name}</span>
        <Badge tone={s === "paid" ? "green" : s === "part" ? "yellow" : late ? "red" : "gray"} dot>
          {s === "paid" ? "Paid" : s === "part" ? "Part paid" : late ? "Overdue" : "Unpaid"}
        </Badge>
      </div>
      <div className="mb-2 text-muted">
        {monthLong(row.period)} · {row.label}
      </div>
      <Facts row={row} />
    </div>
  );
}

function Facts({ row }: { row: LogRow }) {
  const items: [string, ReactNode][] = [
    ["Amount due", money(row.amountDue)],
    ["Collected", money(row.amountCollected)],
    ["Date paid", shortDate(row.paidDate)],
    ["Method", row.method ?? "–"],
  ];
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="num text-right text-ink capitalize">{v}</dd>
          </div>
        ))}
      </dl>
      {row.notes && <p className="mt-2 border-t border-line pt-2 whitespace-pre-line text-soft">{row.notes}</p>}
    </>
  );
}

/* ---------- editor ---------- */

function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/60 p-0 sm:place-items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-line-strong bg-panel p-5 shadow-2xl sm:max-w-md sm:rounded-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <button type="button" onClick={onClose} className="-mt-2 -mr-2 grid size-10 place-items-center rounded-lg text-muted hover:bg-ink/[0.06] hover:text-ink" aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Editor({ row, client, today, onClose, onSave }: { row: LogRow; client: LogClient; today: string; onClose: () => void; onSave: (v: Pick<LogRow, "amountCollected" | "paidDate" | "method" | "notes">) => void }) {
  const [amount, setAmount] = useState(String(row.amountCollected || ""));
  const [paidDate, setPaidDate] = useState(row.paidDate ?? (row.amountCollected > 0 ? "" : today));
  const [method, setMethod] = useState<Method | "">(row.method ?? client.billingMethod);
  const [notes, setNotes] = useState(row.notes ?? "");
  const [err, setErr] = useState<string | null>(null);
  const n = amount.trim() === "" ? 0 : Number(amount.replace(/[€,\s]/g, ""));
  const save = () => {
    if (!Number.isFinite(n) || n < 0) return setErr("Enter an amount, e.g. 500.");
    if (n > row.amountDue + 0.005) return setErr(`That's more than the ${money(row.amountDue)} due. Put the extra on another month.`);
    onSave({ amountCollected: Math.round(n * 100) / 100, paidDate: n > 0 ? paidDate || today : null, method: (method || null) as Method | null, notes: notes.trim() || null });
  };
  return (
    <Modal
      title={
        <span className="flex items-center gap-3">
          <ClientLogo name={client.name} size={34} className="rounded-lg" />
          <span>
            {client.name}
            <span className="block text-xs font-normal text-muted">
              {monthLong(row.period)} · {row.label} · {money(row.amountDue)} due
            </span>
          </span>
        </span>
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="grid gap-3"
      >
        <div>
          <label className={labelCls} htmlFor="pl-amount">
            Amount collected
          </label>
          <div className="flex gap-2">
            <input id="pl-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${input} num`} placeholder="0" />
            <button type="button" className={`${btnGhost} h-10 shrink-0`} onClick={() => setAmount(String(row.amountDue))}>
              Paid in full
            </button>
          </div>
          {n > 0 && n < row.amountDue - 0.005 && <p className="mt-1 text-xs text-amber-300">Part payment: {money(Math.round((row.amountDue - n) * 100) / 100)} still owed.</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="pl-date">
              Date paid
            </label>
            <input id="pl-date" type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} className={`${input} h-10`} />
          </div>
          <div>
            <label className={labelCls} htmlFor="pl-method">
              Method
            </label>
            <select id="pl-method" value={method} onChange={(e) => setMethod(e.target.value as Method | "")} className={`${input} h-10 capitalize`}>
              <option value="">–</option>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="pl-notes">
            Note
          </label>
          <textarea id="pl-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className={input} placeholder="e.g. Paid Oct and Nov together" />
        </div>
        {err && <p className="text-sm text-red-300">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" className={`${btnGhost} h-10`} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={`${btn} h-10`}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------- by month (like the Notion view) ---------- */

function MonthList({ data, h }: { data: ReturnType<typeof buildPaymentLog>; h: CellHandlers }) {
  const groups = byMonth(data).filter((g) => g.items.length);
  if (!groups.length) return <p className="rounded-2xl border border-line bg-panel p-8 text-center text-sm text-muted">No payments in {data.year}.</p>;
  const th = "border-b border-line px-3 py-2 text-[11px] font-semibold tracking-[0.1em] whitespace-nowrap text-muted uppercase";
  return (
    <div className="grid gap-5">
      {groups.map((g) => {
        const paid = g.items.filter((i) => cellState(i.row) === "paid").length;
        return (
          <section key={g.period} className="surface overflow-hidden rounded-2xl border border-line bg-panel" aria-label={monthLong(g.period)}>
            <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
              <h3 className="text-sm font-semibold text-white">{monthLong(g.period)}</h3>
              <span className="text-xs text-muted">
                {paid} of {g.items.length} paid
              </span>
              <span className="num ml-auto text-xs text-soft">
                <span className="text-emerald-300">{money(g.collected)}</span> of {money(g.due)}
              </span>
              <Progress value={g.collected} max={g.due} tone={g.collected >= g.due - 0.005 ? "green" : "brand"} label={`Collected ${monthLong(g.period)}`} className="w-full sm:w-32" />
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-separate border-spacing-0 text-sm">
                <thead>
                  <tr>
                    <th className={`${th} w-14 pl-4 text-center sm:pl-5`}>Paid</th>
                    <th className={`${th} text-left`}>Payment</th>
                    <th className={`${th} text-right`}>Amount due</th>
                    <th className={`${th} text-right`}>Collected</th>
                    <th className={`${th} text-left`}>Date paid</th>
                    <th className={`${th} text-left`}>Method</th>
                    <th className={`${th} pr-4 text-left sm:pr-5`}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map(({ row, client }) => {
                    const s = cellState(row);
                    const late = isOverdue(row, data.today);
                    const who = `${client.name}${row.label !== "Retainer" ? ` ${row.label}` : ""}, ${monthLong(row.period)}`;
                    return (
                      <tr key={row.id} className={`align-middle ${late ? "bg-red-500/[0.07]" : ""}`}>
                        <td className="border-t border-line/70 py-1 pl-4 text-center sm:pl-5">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={s === "paid" ? true : s === "part" ? "mixed" : false}
                            aria-label={`${who}: ${s === "paid" ? "paid" : s === "part" ? "part paid" : late ? "overdue" : "unpaid"}`}
                            onClick={() => h.onToggle(row)}
                            className="grid size-10 place-items-center rounded-lg hover:bg-ink/[0.06] focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none"
                          >
                            <TickBox state={s === "none" ? "unpaid" : s} overdue={late} />
                          </button>
                        </td>
                        <td className="border-t border-line/70 px-3 py-2">
                          <span className="flex items-center gap-2.5">
                            <ClientLogo name={client.name} size={28} className="rounded-lg" />
                            <span className="min-w-0">
                              <span className="block font-medium whitespace-nowrap text-white">{client.name}</span>
                              <span className="block text-xs text-muted">
                                {monthShort(row.period)} {row.period.slice(0, 4)} · {row.label}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="num border-t border-line/70 px-3 py-2 text-right whitespace-nowrap">{money(row.amountDue)}</td>
                        <td className="border-t border-line/70 px-3 py-1 text-right">
                          <button type="button" onClick={() => h.onEdit(row)} aria-label={`Edit ${who}`} className={`num h-10 rounded-md px-2 whitespace-nowrap underline decoration-dotted underline-offset-4 hover:bg-ink/[0.06] ${s === "paid" ? "text-white" : s === "part" ? "text-amber-300" : "text-muted"}`}>
                            {money(row.amountCollected)}
                          </button>
                        </td>
                        <td className="border-t border-line/70 px-3 py-2 whitespace-nowrap text-soft">{row.paidDate ? shortDate(row.paidDate) : late ? <span className="text-red-300">Overdue</span> : "–"}</td>
                        <td className="border-t border-line/70 px-3 py-2 text-soft capitalize">{row.method ?? "–"}</td>
                        <td className="max-w-72 border-t border-line/70 px-3 py-2 pr-4 text-xs whitespace-pre-line text-muted sm:pr-5">{row.notes ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* ---------- Stripe payments to assign ---------- */

export interface AssignOption {
  paymentId?: number;
  period: string;
  label: string;
  owed: number;
  exists: boolean;
}
export interface AssignClient {
  clientId: number;
  name: string;
  status: string;
  options: AssignOption[];
}
export interface ToAssign {
  id: number;
  receivedDate: string;
  amount: number;
  remaining: number;
  payer: string | null;
  reference: string | null;
  description: string | null;
  notes: string | null;
  clientId: number | null;
  stripeCustomerId: string | null;
  /** Suggested rows, best first. */
  suggested: { paymentId: number; clientId: number; period: string; label: string; reasons: string[] }[];
}

const optKey = (o: Pick<AssignOption, "paymentId" | "period" | "label">) => (o.paymentId ? `p${o.paymentId}` : `n${o.period}`);
const optLabel = (o: AssignOption) => `${monthShort(o.period)} ${o.period.slice(0, 4)}${o.label !== "Retainer" ? ` ${o.label}` : ""}`;

export function StripeToAssign({ items, clients }: { items: ToAssign[]; clients: AssignClient[] }) {
  const [pending, start] = useTransition();
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [splitting, setSplitting] = useState<ToAssign | null>(null);
  const byId = useMemo(() => new Map(clients.map((c) => [c.clientId, c])), [clients]);
  const visible = items.filter((i) => !hidden.has(i.id));

  const act = (id: number, fn: () => Promise<LogResult>) =>
    start(async () => {
      setError(null);
      setHidden((h) => new Set(h).add(id));
      try {
        const r = await fn();
        if (!r.ok) {
          setError(r.error);
          setHidden((h) => {
            const n = new Set(h);
            n.delete(id);
            return n;
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't save that.");
        setHidden((h) => {
          const n = new Set(h);
          n.delete(id);
          return n;
        });
      }
    });

  if (!visible.length) return null;
  return (
    <section className="surface mb-6 rounded-2xl border border-brand/40 bg-panel shadow-[0_0_30px_rgb(4_153_242/0.12)]" aria-label="Stripe payments to assign" data-testid="stripe-to-assign">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
        <Badge tone="brand">Stripe</Badge>
        <h2 className="text-sm font-semibold text-white">
          Payments to assign <span className="text-muted">({visible.length})</span>
        </h2>
        <p className="w-full text-xs text-muted sm:ml-auto sm:w-auto">Nothing is ticked automatically. Pick the month(s) each payment covers.</p>
      </header>
      {error && <p className="border-b border-line bg-red-500/10 px-5 py-2 text-sm text-red-200">{error}</p>}
      <ul className="divide-y divide-line/70">
        {visible.map((i) => {
          const client = i.clientId ? byId.get(i.clientId) : undefined;
          const quick: { o: AssignOption; c: AssignClient }[] = [];
          for (const sg of i.suggested) {
            const c = byId.get(sg.clientId);
            const o = c?.options.find((x) => x.paymentId === sg.paymentId);
            if (c && o && quick.length < 2) quick.push({ o, c });
          }
          if (!quick.length && client) {
            const first = client.options.find((o) => o.exists) ?? client.options[0];
            if (first) quick.push({ o: first, c: client });
          }
          return (
            <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
              <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                {client ? <ClientLogo name={client.name} size={34} className="rounded-lg" /> : <span className="grid size-[34px] shrink-0 place-items-center rounded-lg border border-dashed border-line-strong text-muted">?</span>}
                <div className="min-w-0">
                  <div className="truncate font-medium text-white">{client?.name ?? i.payer ?? "Unknown customer"}</div>
                  <div className="truncate text-xs text-muted">
                    {shortDate(i.receivedDate)} · {i.reference ?? i.description ?? "Stripe"}
                    {!client && i.payer ? " · client not linked" : ""}
                  </div>
                  {i.notes && <div className="text-xs text-amber-300/80">{i.notes}</div>}
                </div>
              </div>
              <div className="num text-right text-base font-semibold text-white">
                {money(i.remaining)}
                {i.remaining < i.amount - 0.005 && <div className="text-xs font-normal text-muted">left of {money(i.amount)}</div>}
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                {quick.map(({ o, c }) => (
                  <button
                    key={`${c.clientId}${optKey(o)}`}
                    type="button"
                    disabled={pending}
                    className={`${btn} h-10`}
                    onClick={() => act(i.id, () => assignPaymentAction(i.id, [o.paymentId ? { paymentId: o.paymentId } : { clientId: c.clientId, period: o.period }], !i.clientId && !!i.stripeCustomerId))}
                  >
                    <Icon name="check" className="size-3.5" /> {!client ? `${c.name}: ` : ""}
                    {optLabel(o)}
                  </button>
                ))}
                <button type="button" disabled={pending} className={`${btnGhost} h-10`} onClick={() => setSplitting(i)}>
                  {quick.length ? "Other / split…" : "Choose months…"}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  className={`${btnGhost} ${btnSm} !h-10 text-muted`}
                  onClick={() => window.confirm(`Ignore this ${money(i.remaining)} Stripe payment? It won't be counted against any month.`) && act(i.id, () => ignorePaymentAction(i.id))}
                >
                  Ignore
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {splitting && (
        <SplitDialog
          item={splitting}
          clients={clients}
          onClose={() => setSplitting(null)}
          onApply={(parts, link) => {
            const id = splitting.id;
            setSplitting(null);
            act(id, () => assignPaymentAction(id, parts, link));
          }}
        />
      )}
    </section>
  );
}

function SplitDialog({
  item,
  clients,
  onClose,
  onApply,
}: {
  item: ToAssign;
  clients: AssignClient[];
  onClose: () => void;
  onApply: (parts: { paymentId?: number; clientId?: number; period?: string; amount: number }[], linkCustomer: boolean) => void;
}) {
  const [clientId, setClientId] = useState<number>(item.clientId ?? item.suggested[0]?.clientId ?? clients.find((c) => c.status === "active")?.clientId ?? clients[0]?.clientId);
  const client = clients.find((c) => c.clientId === clientId);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [link, setLink] = useState(!item.clientId && !!item.stripeCustomerId);
  const chosen = Object.entries(amounts).filter(([, v]) => v !== "");
  const total = Math.round(chosen.reduce((s, [, v]) => s + (Number(v) || 0), 0) * 100) / 100;
  const left = Math.round((item.remaining - total) * 100) / 100;

  const toggle = (o: AssignOption) => {
    const k = optKey(o);
    setAmounts((a) => {
      if (a[k] !== undefined) {
        const { [k]: _drop, ...rest } = a;
        return rest;
      }
      const used = Object.values(a).reduce((s, v) => s + (Number(v) || 0), 0);
      const fill = Math.max(0, Math.min(o.owed, Math.round((item.remaining - used) * 100) / 100));
      return { ...a, [k]: String(fill || o.owed) };
    });
  };

  const apply = () => {
    if (!client) return;
    const parts = client.options
      .filter((o) => amounts[optKey(o)] !== undefined && Number(amounts[optKey(o)]) > 0)
      .map((o) => ({ ...(o.paymentId ? { paymentId: o.paymentId } : { clientId: client.clientId, period: o.period }), amount: Number(amounts[optKey(o)]) }));
    if (parts.length) onApply(parts, link);
  };

  return (
    <Modal title={`Assign ${money(item.remaining)} from ${item.payer ?? "Stripe"}`} onClose={onClose}>
      <p className="-mt-2 mb-4 text-xs text-muted">
        Received {shortDate(item.receivedDate)}
        {item.reference ? ` · ${item.reference}` : ""}. Tick the month(s) it covers; split it by changing the amounts.
      </p>
      <label className={labelCls} htmlFor="split-client">
        Client
      </label>
      <select
        id="split-client"
        value={clientId}
        onChange={(e) => {
          setClientId(Number(e.target.value));
          setAmounts({});
        }}
        className={`${input} mb-4 h-10`}
      >
        {clients.map((c) => (
          <option key={c.clientId} value={c.clientId}>
            {c.name}
            {c.status !== "active" ? ` (${c.status})` : ""}
          </option>
        ))}
      </select>
      {client && client.options.length ? (
        <ul className="grid gap-1.5" aria-label="Months">
          {client.options.map((o) => {
            const k = optKey(o);
            const on = amounts[k] !== undefined;
            return (
              <li key={k} className={`flex items-center gap-2 rounded-xl border px-2 ${on ? "border-brand/50 bg-brand-soft" : "border-line"}`}>
                <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-3 px-1">
                  <input type="checkbox" checked={on} onChange={() => toggle(o)} className="size-5 accent-[var(--color-brand)]" />
                  <span className="text-sm text-white">{optLabel(o)}</span>
                  <span className="text-xs text-muted">{o.exists ? `${money(o.owed)} owed` : `not billed yet · ${money(o.owed)}`}</span>
                </label>
                {on && (
                  <input
                    aria-label={`Amount for ${optLabel(o)}`}
                    inputMode="decimal"
                    value={amounts[k]}
                    onChange={(e) => setAmounts((a) => ({ ...a, [k]: e.target.value }))}
                    className={`${field} num h-10 w-28 text-right`}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-xl border border-line p-4 text-sm text-muted">{client?.name ?? "This client"} has no open months and no retainer to bill ahead.</p>
      )}
      {item.stripeCustomerId && !item.clientId && (
        <label className="mt-4 flex min-h-10 items-center gap-2 text-xs text-soft">
          <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} className="size-4" /> Save {item.stripeCustomerId} on {client?.name ?? "the client"} so their next payment shows their name
        </label>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className={`num text-sm ${left < -0.005 ? "text-red-300" : "text-muted"}`}>
          {money(total)} chosen · {left < -0.005 ? `${money(-left)} too much` : `${money(Math.max(left, 0))} left over`}
        </span>
        <div className="flex gap-2">
          <button type="button" className={`${btnGhost} h-10`} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${btn} h-10`} disabled={!chosen.length || left < -0.005 || total <= 0} onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}
