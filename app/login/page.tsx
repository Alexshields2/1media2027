"use client";

import { useActionState } from "react";
import { login } from "../actions";
import { LogoMark } from "../_components/logo";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, {});
  return (
    <div className="home-glow grid min-h-screen place-items-center px-4">
      <form action={action} className="w-full max-w-sm rounded-2xl border border-ink/[0.08] bg-panel p-8 shadow-2xl shadow-black/50">
        <div className="mb-8 flex flex-col items-center">
          <LogoMark className="h-16 w-12" />
          <span className="mt-2 text-xl font-extrabold tracking-[0.2em]">MEDIA</span>
          <span className="mt-1 text-[11px] font-medium tracking-[0.2em] text-ink/40 uppercase">Operating system</span>
        </div>
        <label className="mb-1 block text-xs font-medium text-ink/60" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoFocus
          required
          className="w-full rounded-lg border border-ink/15 bg-canvas px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
        {state?.error && <p className="mt-2 text-sm text-red-400">{state.error}</p>}
        <button disabled={pending} className="brand-gradient mt-5 w-full rounded-lg py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
