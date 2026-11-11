"use client";

import { useActionState } from "react";
import { login } from "../actions";

const inputCls = "w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

export function LoginForm({ firstRun }: { firstRun: boolean }) {
  const [state, action, pending] = useActionState(login, {});
  return (
    <form action={action}>
      {firstRun ? (
        <p className="mb-4 rounded-lg bg-brand-soft px-3 py-2 text-xs text-ink/70">First sign-in: enter the shared ADMIN_PASSWORD. You&rsquo;ll then have your own owner account.</p>
      ) : (
        <>
          <label className="mb-1 block text-xs font-medium text-ink/60" htmlFor="email">
            Email
          </label>
          <input id="email" name="email" type="email" autoComplete="username" autoFocus required className={`${inputCls} mb-4`} />
        </>
      )}
      <label className="mb-1 block text-xs font-medium text-ink/60" htmlFor="password">
        Password
      </label>
      <input id="password" name="password" type="password" autoComplete="current-password" autoFocus={firstRun} required className={inputCls} />
      {state?.error && <p className="mt-2 text-sm text-red-400">{state.error}</p>}
      <button disabled={pending} className="mt-5 w-full rounded-full bg-white py-2.5 text-sm font-semibold text-[#020617] hover:bg-white/90 disabled:opacity-50">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
