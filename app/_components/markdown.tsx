import type { ReactNode } from "react";

// A small Markdown renderer for SOP breakdowns and briefs: headings, lists, bold, italics, links, code.
// Builds React elements (no raw HTML), so agent-written text can't inject markup.

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("**")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k} className="rounded bg-black/5 px-1 text-[0.9em]">{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) {
      const label = t.slice(1, t.indexOf("]"));
      out.push(
        <a key={k} href={m[2]} target="_blank" rel="noreferrer" className="text-brand underline">
          {label}
        </a>,
      );
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const cls = level <= 2 ? "mt-5 mb-2 text-base font-semibold first:mt-0" : "mt-4 mb-1 text-sm font-semibold first:mt-0";
      blocks.push(level <= 2 ? <h3 key={key++} className={cls}>{inline(h[2], key)}</h3> : <h4 key={key++} className={cls}>{inline(h[2], key)}</h4>);
      i++;
      continue;
    }
    if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*(?:[-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""));
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key++} className={`my-2 space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, key * 100 + j)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*(?:[-*•]|\d+[.)])\s+/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="my-2">
        {inline(para.join(" "), key)}
      </p>,
    );
  }
  return <div className={`text-sm leading-relaxed text-black/80 ${className}`}>{blocks}</div>;
}
