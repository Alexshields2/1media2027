// The 1Media logo (public/1media-logo.png): the blue "1" with MEDIA underneath.
/* eslint-disable @next/next/no-img-element */

export function LogoMark({ className = "h-10" }: { className?: string }) {
  return <img src="/1media-logo.png" alt="1Media" className={`w-auto ${className}`} />;
}

export function Logo({ sub }: { sub?: string }) {
  return (
    <span className="flex items-center gap-3">
      <LogoMark className="h-11" />
      {sub && <span className="text-[10px] leading-tight font-semibold tracking-[0.22em] text-muted uppercase">{sub}</span>}
    </span>
  );
}
