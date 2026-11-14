import { aiCategoriserReady, categoriseWithClaude } from "../expense-ai";
import { notify } from "../slack";
import { RevolutAuthError } from "./api";
import { currentStatus } from "./connection";
import { syncRevolut, type SyncResult } from "./sync";

// One Revolut sync as the cron job and the "Sync now" button run it: skip quietly when Revolut isn't
// connected, sync, then let Claude categorise what the rules couldn't (when ANTHROPIC_API_KEY is set).
// Returns a summary that never contains tokens.

export type RunResult =
  | { ok: true; result: SyncResult; aiCategorised: number }
  | { ok: false; skipped?: string; needsReauth?: boolean; error?: string };

export async function runRevolutSync(trigger: "cron" | "manual"): Promise<RunResult> {
  const { status } = await currentStatus();
  if (status === "needs_reauth") return { ok: false, needsReauth: true, skipped: "Revolut needs re-authorising" };
  if (status !== "connected") return { ok: false, skipped: "Revolut isn't connected" };
  try {
    const result = await syncRevolut();
    let aiCategorised = 0;
    if (aiCategoriserReady() && result.uncategorised > 0) {
      aiCategorised = (await categoriseWithClaude().catch((e) => (console.error("expense categorisation failed", e), { updated: 0 }))).updated;
    }
    return { ok: true, result, aiCategorised };
  } catch (e) {
    const needsReauth = e instanceof RevolutAuthError;
    const error = e instanceof Error ? e.message : String(e);
    console.error(`revolut sync (${trigger}) failed:`, error);
    if (trigger === "cron") await notify(needsReauth ? "Revolut needs re-authorising: open Integrations and click Authorise." : `Revolut sync failed: ${error}`).catch(() => {});
    return { ok: false, needsReauth, error };
  }
}
