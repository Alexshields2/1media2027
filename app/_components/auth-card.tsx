import { LogoMark } from "./logo";

/** The centred card used by the sign-in and first-run setup pages. */
export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="home-glow grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="surface rounded-3xl border border-line bg-panel/80 p-7 shadow-[0_0_80px_rgb(4_153_242/0.14)] backdrop-blur sm:p-8">
          <div className="mb-8 flex flex-col items-center">
            <LogoMark className="h-24" />
            <span className="mt-4 text-[11px] font-semibold tracking-[0.22em] text-muted uppercase">Operating system</span>
          </div>
          {children}
        </div>
        <p className="mt-6 text-center text-xs text-muted">1Media · Digital marketing, Ireland</p>
      </div>
    </main>
  );
}
