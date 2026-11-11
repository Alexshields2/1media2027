import { useId } from "react";

// The 1Media mark: a blue gradient "1" with a lighter facet, and the MEDIA wordmark.

export function LogoMark({ className = "size-8" }: { className?: string }) {
  // Unique per instance: a gradient defined inside a hidden (display:none) copy wouldn't paint.
  const id = `om-one-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  return (
    <svg viewBox="0 0 64 80" className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8fd3fb" />
          <stop offset="0.5" stopColor="#3d8fe6" />
          <stop offset="1" stopColor="#1c5fb8" />
        </linearGradient>
      </defs>
      {/* stem + flag */}
      <path d="M16 18 L44 2 L52 2 L52 78 L34 78 L34 26 L16 32 Z" fill={`url(#${id})`} />
      {/* facet */}
      <path d="M52 2 L52 60 L34 78 L34 26 Z" fill="#ffffff" opacity="0.16" />
    </svg>
  );
}

export function Logo({ sub }: { sub?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark className="h-8 w-7 shrink-0" />
      <span className="leading-none">
        <span className="block text-[15px] font-extrabold tracking-[0.18em] text-ink">MEDIA</span>
        {sub && <span className="mt-1 block text-[10px] font-medium tracking-[0.2em] text-ink/40 uppercase">{sub}</span>}
      </span>
    </span>
  );
}
