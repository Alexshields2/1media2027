import { headers } from "next/headers";
import { currentStatus, usesEnvKey, type RevolutStatus } from "@/lib/revolut/connection";
import { redirectUriFor, revolutEnv } from "@/lib/revolut/api";
import { Badge, Card, Notice, btn, btnGhost, btnSm, field } from "../_components/ui";
import { Icon } from "../_components/icons";
import { CopyButton, SubmitButton } from "../_components/client-bits";
import { revolutAuthoriseAction, revolutCertificateAction, revolutClientIdAction, revolutDisconnectAction, revolutSyncAction } from "./revolut-actions";

const STATUS: Record<RevolutStatus, { label: string; tone: string }> = {
  no_key: { label: "Not set up", tone: "gray" },
  needs_client_id: { label: "Waiting for client ID", tone: "yellow" },
  not_authorised: { label: "Not authorised", tone: "yellow" },
  connected: { label: "Connected", tone: "green" },
  needs_reauth: { label: "Needs re-authorising", tone: "red" },
};

const when = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IE", { timeZone: "Europe/Dublin", dateStyle: "medium", timeStyle: "short" }) : "never");

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? "bg-emerald-500/20 text-emerald-300" : "border border-line bg-panel-2 text-soft"}`}>
        {done ? <Icon name="check" className="size-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium text-white">{title}</h4>
        <div className="mt-1.5 space-y-2 text-sm text-soft">{children}</div>
      </div>
    </li>
  );
}

/** Revolut Business (direct API, no Composio): certificate → client ID → authorise → daily sync. */
export async function RevolutCard() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "1media2027.vercel.app";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const redirectUri = redirectUriFor(`${proto}://${host}`);
  const { status, conn } = await currentStatus();
  const s = STATUS[status];
  const cert = conn?.certificatePem ?? null;
  const result = conn?.lastSyncResult as { transactions?: number; expensesAdded?: number; incomeAdded?: number } | null | undefined;
  const sandbox = revolutEnv() === "sandbox";

  return (
    <Card id="revolut" className="scroll-mt-24">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-panel-2 text-sm font-bold">
          <span className="brand-text">R</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Revolut Business{sandbox && <span className="ml-2 text-xs font-normal text-amber-300">sandbox</span>}</h3>
            <Badge tone={s.tone} dot>
              {s.label}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            Every card payment, transfer and fee goes to Expenses, categorised. Money in waits on Payments as unmatched, for you to assign. Read-only access; synced daily.
          </p>
        </div>
      </div>

      {status === "needs_reauth" && (
        <Notice tone="error" title="Revolut needs re-authorising" className="mt-4 !mb-0">
          Revolut stopped accepting the saved sign-in (it expires periodically). Click Authorise below to reconnect; nothing else needs setting up again.
        </Notice>
      )}
      {conn?.lastError && status === "connected" && (
        <Notice tone="warn" title="Last sync failed" className="mt-4 !mb-0">
          {conn.lastError}
        </Notice>
      )}

      {status === "connected" ? (
        <div className="mt-4 space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">Last sync</dt>
              <dd className="text-white">{when(conn?.lastSyncAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Last result</dt>
              <dd className="text-white">{result ? `${result.expensesAdded ?? 0} expenses, ${result.incomeAdded ?? 0} in` : "–"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Accounts</dt>
              <dd className="truncate text-white">{conn?.accounts.length ? conn.accounts.map((a) => a.name || a.currency).join(", ") : "–"}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <form action={revolutSyncAction}>
              <SubmitButton className={`${btn} ${btnSm}`} pendingText="Syncing…">
                <Icon name="history" className="size-3.5" /> Sync now
              </SubmitButton>
            </form>
            <form action={revolutAuthoriseAction}>
              <SubmitButton className={`${btnGhost} ${btnSm}`} pendingText="Opening…">
                Re-authorise
              </SubmitButton>
            </form>
            <form action={revolutDisconnectAction}>
              <SubmitButton className={`${btnGhost} ${btnSm}`} pendingText="…">
                Disconnect
              </SubmitButton>
            </form>
          </div>
        </div>
      ) : (
        <ol className="mt-5 space-y-5">
          <Step n={1} done={!!cert} title="Create the certificate">
            {cert ? (
              <>
                <p>
                  In Revolut Business go to <b>Settings → APIs → Business API → Add API certificate</b>. Give it a title (e.g. “1Media OS”), paste this redirect URI and the public
                  certificate below, and save.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 rounded-md border border-line bg-canvas/60 px-2 py-1 text-xs break-all text-white">{redirectUri}</code>
                  <CopyButton text={redirectUri} className={`${btnGhost} ${btnSm}`} />
                </div>
                <div className="relative">
                  <pre aria-label="Public certificate" className="max-h-32 overflow-auto rounded-lg border border-line bg-canvas/60 p-3 font-mono text-[11px] leading-snug text-soft">
                    {cert}
                  </pre>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <CopyButton text={cert} className={`${btnGhost} ${btnSm}`} />
                    <a className={`${btnGhost} ${btnSm}`} download="1media-os-revolut.cer" href={`data:application/x-x509-ca-cert;base64,${Buffer.from(cert).toString("base64")}`}>
                      <Icon name="download" className="size-3.5" /> Download .cer
                    </a>
                  </div>
                </div>
                <p className="text-xs text-muted">
                  This is the public half only. The private key {usesEnvKey() ? "comes from REVOLUT_PRIVATE_KEY" : "is stored encrypted on the server"} and is never shown.
                </p>
              </>
            ) : (
              <form action={revolutCertificateAction}>
                <p className="mb-2">The server makes a key pair and a certificate for Revolut. The private key stays encrypted on the server.</p>
                <SubmitButton className={`${btn} ${btnSm}`} pendingText="Generating…">
                  <Icon name="key" className="size-3.5" /> Generate certificate
                </SubmitButton>
              </form>
            )}
          </Step>
          <Step n={2} done={!!conn?.clientId} title="Paste the client ID">
            <p>Revolut shows a Client ID once the certificate is saved. It isn&rsquo;t secret.</p>
            <form action={revolutClientIdAction} className="flex flex-wrap items-center gap-2">
              <input name="clientId" defaultValue={conn?.clientId ?? ""} required placeholder="Client ID from Revolut" aria-label="Revolut client ID" className={`${field} w-72 max-w-full font-mono text-xs`} disabled={!cert} />
              <SubmitButton className={`${btnGhost} ${btnSm}`} pendingText="Saving…">
                Save
              </SubmitButton>
            </form>
          </Step>
          <Step n={3} done={false} title="Authorise">
            <p>Opens Revolut to approve read access, then comes back here and runs the first sync (the last 90 days).</p>
            <form action={revolutAuthoriseAction}>
              <SubmitButton className={`${btn} ${btnSm}`} pendingText="Opening…">
                <Icon name="external" className="size-3.5" /> {status === "needs_reauth" ? "Authorise again" : "Authorise with Revolut"}
              </SubmitButton>
            </form>
          </Step>
        </ol>
      )}
    </Card>
  );
}
