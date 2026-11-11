import { LogoMark } from "./logo";

/** The centred card used by the sign-in and first-run setup pages. */
export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="home-glow grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm rounded-3xl border border-line bg-panel/80 p-8 shadow-[0_0_60px_rgb(4_153_242/0.12)] backdrop-blur">
        <div className="mb-8 flex flex-col items-center">
          <LogoMark className="h-24" />
          <span className="mt-4 text-[11px] font-medium tracking-[0.2em] text-ink/40 uppercase">Operating system</span>
        </div>
        {children}
      </div>
    </div>
  );
}
