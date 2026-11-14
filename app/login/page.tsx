"use client";

import { useActionState } from "react";
import { login } from "../actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, {});
  const field = "w-full rounded-md border border-black/15 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form action={action} className="w-full max-w-sm rounded-xl border border-black/10 bg-white p-6">
        <div className="mb-6 flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-brand font-bold text-white">1</span>
          <span className="text-lg font-semibold tracking-tight">1Media OS</span>
        </div>
        <label className="mb-1 block text-xs font-medium text-black/60" htmlFor="name">
          Name or email
        </label>
        <input id="name" name="name" autoFocus autoComplete="username" placeholder="e.g. Jamie" className={field} />
        <label className="mt-3 mb-1 block text-xs font-medium text-black/60" htmlFor="password">
          Password
        </label>
        <input id="password" name="password" type="password" required autoComplete="current-password" className={field} />
        {state?.error && <p className="mt-2 text-sm text-red-600">{state.error}</p>}
        <button disabled={pending} className="mt-4 w-full rounded-md bg-black py-2 text-sm font-medium text-white hover:bg-black/80 disabled:opacity-50">
          {pending ? "Signing in…" : "Sign in"}
        </button>
        <p className="mt-4 text-xs text-black/50">Alex: sign in with the admin password, then set passwords for the team under Team.</p>
      </form>
    </div>
  );
}
