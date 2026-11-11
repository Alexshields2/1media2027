"use client";

import { useActionState } from "react";
import { setupOwner } from "../actions";

const inputCls = "mb-4 w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
const labelCls = "mb-1 block text-xs font-medium text-ink/60";

export function SetupForm({ minLength }: { minLength: number }) {
  const [state, action, pending] = useActionState(setupOwner, {});
  return (
    <form action={action}>
      <p className="mb-5 text-sm text-ink/60">Create the first owner account. After this, everyone signs in with their own email and password, and the shared ADMIN_PASSWORD stops working.</p>
      <label className={labelCls} htmlFor="name">Your name</label>
      <input id="name" name="name" required autoFocus className={inputCls} />
      <label className={labelCls} htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required autoComplete="username" className={inputCls} />
      <label className={labelCls} htmlFor="password">Password</label>
      <input id="password" name="password" type="password" required minLength={minLength} autoComplete="new-password" className={inputCls} />
      <label className={labelCls} htmlFor="confirm">Password again</label>
      <input id="confirm" name="confirm" type="password" required minLength={minLength} autoComplete="new-password" className={inputCls} />
      {state?.error && <p className="mb-2 text-sm text-red-400">{state.error}</p>}
      <button disabled={pending} className="mt-1 w-full rounded-full bg-white py-2.5 text-sm font-semibold text-[#020617] hover:bg-white/90 disabled:opacity-50">
        {pending ? "Creating…" : "Create owner account"}
      </button>
    </form>
  );
}
