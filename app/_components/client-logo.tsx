/* eslint-disable @next/next/no-img-element */
import { clientLogo, initials } from "@/lib/client-logos";

/** A client's logo on a tile that suits it (light logos get a dark tile), or their initials. */
export function ClientLogo({ name, size = 32, className = "" }: { name: string; size?: number; className?: string }) {
  const logo = clientLogo(name);
  const box = { width: size, height: size };
  if (!logo)
    return (
      <span
        style={{ ...box, fontSize: Math.max(11, Math.round(size * 0.34)) }}
        className={`grid shrink-0 place-items-center rounded-xl border border-line bg-gradient-to-br from-panel to-canvas font-bold tracking-tight ${className}`}
        aria-hidden
      >
        <span className="brand-text">{initials(name)}</span>
      </span>
    );
  return (
    <span style={box} className={`grid shrink-0 place-items-center overflow-hidden rounded-xl border border-line ${logo.dark ? "bg-[#0b1426]" : "bg-white"} ${className}`}>
      <img src={logo.src} alt="" loading="lazy" className="max-h-full max-w-full object-contain p-[8%]" />
    </span>
  );
}

/** A wide banner version for cards and the client page hero. */
export function ClientBanner({ name, className = "" }: { name: string; className?: string }) {
  const logo = clientLogo(name);
  if (!logo)
    return (
      <div className={`grid place-items-center bg-[radial-gradient(70%_90%_at_50%_0%,rgb(4_153_242/0.22),transparent_70%)] ${className}`}>
        <span className="brand-text text-4xl font-extrabold tracking-tight">{initials(name)}</span>
      </div>
    );
  return (
    <div className={`grid place-items-center ${logo.dark ? "bg-[radial-gradient(70%_90%_at_50%_0%,rgb(4_153_242/0.18),#081226_75%)]" : "bg-white"} ${className}`}>
      <img src={logo.src} alt="" loading="lazy" className="max-h-20 max-w-[78%] object-contain" />
    </div>
  );
}
