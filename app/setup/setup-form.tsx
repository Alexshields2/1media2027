"use client";

import { useActionState } from "react";
import { setupOwner } from "../actions";
import { btn, input, label } from "../_components/ui";

const inputCls = `${input} mb-4 py-2.5`;
const labelCls = label;

export function SetupForm({ minLength }: { minLength: number }) {
  const [state, action, pending] = useActionState(setupOwner, {});
  return (
    <form action={action}>
      <h1 className="mb-1 text-center text-lg font-semibold text-white">Set up 1Media OS</h1>
      <p className="mb-6 text-center text-sm leading-relaxed text-muted">Create the first owner account. After this, everyone signs in with their own email and password, and the shared ADMIN_PASSWORD stops working.</p>
      <label className={labelCls} htmlFor="name">Your name</label>
      <input id="name" name="name" required autoFocus className={inputCls} />
      <label className={labelCls} htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required autoComplete="username" className={inputCls} />
      <label className={labelCls} htmlFor="password">Password</label>
      <input id="password" name="password" type="password" required minLength={minLength} autoComplete="new-password" className={inputCls} />
      <label className={labelCls} htmlFor="confirm">Password again</label>
      <input id="confirm" name="confirm" type="password" required minLength={minLength} autoComplete="new-password" className={inputCls} />
      {state?.error && (
        <p role="alert" className="mb-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {state.error}
        </p>
      )}
      <button disabled={pending} className={`${btn} mt-2 w-full py-2.5 font-semibold`}>
        {pending ? "Creating…" : "Create owner account"}
      </button>
    </form>
  );
}
