"use client";

import { useActionState } from "react";
import { login } from "../actions";
import { LogoMark } from "../_components/logo";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, {});
  return (
    <div className="home-glow grid min-h-screen place-items-center px-4">
      <form action={action} className="w-full max-w-sm rounded-3xl border border-line bg-panel/80 p-8 shadow-[0_0_60px_rgb(4_153_242/0.12)] backdrop-blur">
        <div className="mb-8 flex flex-col items-center">
          <LogoMark className="h-24" />
          <span className="mt-4 text-[11px] font-medium tracking-[0.2em] text-ink/40 uppercase">Operating system</span>
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
          className="w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
        {state?.error && <p className="mt-2 text-sm text-red-400">{state.error}</p>}
        <button disabled={pending} className="mt-5 w-full rounded-full bg-white py-2.5 text-sm font-semibold text-[#020617] hover:bg-white/90 disabled:opacity-50">
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
