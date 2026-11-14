"use client";

import { useActionState } from "react";
import { login } from "../actions";
import { btn, input, label } from "../_components/ui";

const inputCls = `${input} py-2.5`;

export function LoginForm({ firstRun }: { firstRun: boolean }) {
  const [state, action, pending] = useActionState(login, {});
  return (
    <form action={action}>
      {firstRun ? (
        <p className="mb-5 rounded-xl border border-brand/25 bg-brand-soft px-3.5 py-2.5 text-xs leading-relaxed text-soft">First sign-in: enter the shared ADMIN_PASSWORD. You&rsquo;ll then have your own owner account.</p>
      ) : (
        <>
          <label className={label} htmlFor="email">
            Email
          </label>
          <input id="email" name="email" type="email" autoComplete="username" autoFocus required className={`${inputCls} mb-4`} />
        </>
      )}
      <label className={label} htmlFor="password">
        Password
      </label>
      <input id="password" name="password" type="password" autoComplete="current-password" autoFocus={firstRun} required className={inputCls} />
      {state?.error && (
        <p role="alert" className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {state.error}
        </p>
      )}
      <button disabled={pending} className={`${btn} mt-6 w-full py-2.5 font-semibold`}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
