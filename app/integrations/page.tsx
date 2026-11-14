import { requirePermission } from "@/lib/session";
import { APPS, appStates, ComposioError, composioReady, type AppState } from "@/lib/composio-connect";
import { Badge, Card, Notice, PageHeader, btn, btnGhost, btnSm } from "../_components/ui";
import { Icon } from "../_components/icons";
import { SubmitButton } from "../_components/client-bits";
import { connectApp, disconnectApp } from "./actions";
import { RevolutCard } from "./revolut-card";

export const dynamic = "force-dynamic";

const STATUS: Record<AppState["status"], { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "green" },
  pending: { label: "Login not finished", tone: "yellow" },
  failed: { label: "Needs reconnecting", tone: "red" },
  not_connected: { label: "Not connected", tone: "gray" },
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string; revolut?: string; detail?: string }> }) {
  await requirePermission("manage_integrations", "manage integrations");
  const sp = await searchParams;
  const ready = composioReady();

  let apps: AppState[] = APPS.map((a) => ({ ...a, status: "not_connected" as const }));
  let loadError: string | null = null;
  if (ready) {
    try {
      apps = await appStates();
    } catch (e) {
      loadError = e instanceof ComposioError ? e.message : "Couldn't reach Composio just now.";
    }
  }
  const connected = apps.filter((a) => a.status === "connected").length;
  const groups = [...new Set(apps.map((a) => a.group))];
  const justConnected = sp.connected ? APPS.find((a) => a.slug === sp.connected)?.name : null;

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Integrations"
        subtitle={ready ? `${connected} of ${apps.length} apps connected. Agents can only use the apps connected here.` : "Connect the apps your agents work in."}
      />

      {!ready && (
        <Notice tone="warn" title="Composio isn't set up yet" className="mb-6">
          Add <code>COMPOSIO_API_KEY</code> (your Composio project key, starting <code>ak_</code>) in Vercel → Settings → Environment Variables, then redeploy. The
          Connect buttons work after that.
        </Notice>
      )}
      {justConnected && (
        <Notice tone="success" title={`Back from ${justConnected}`} className="mb-6">
          If the login finished, it shows as Connected below. If it still says “Login not finished”, click Connect again.
        </Notice>
      )}
      {sp.error && (
        <Notice tone="error" title="That didn't work" className="mb-6">
          {sp.error}
        </Notice>
      )}
      {sp.revolut === "connected" && (
        <Notice tone="success" title="Revolut is connected" className="mb-6">
          The first sync (last 90 days) is running now. New expenses show on Expenses; money in waits under Unmatched on Payments.
        </Notice>
      )}
      {sp.revolut === "synced" && (
        <Notice tone="success" title="Revolut synced" className="mb-6">
          {sp.detail}
        </Notice>
      )}
      {loadError && (
        <Notice tone="error" title="Couldn't load connections" className="mb-6">
          {loadError}
        </Notice>
      )}

      <div className="space-y-8">
        <section>
          <h2 className="mb-3 text-xs font-semibold tracking-[0.16em] text-muted uppercase">Banking</h2>
          <div className="max-w-3xl">
            <RevolutCard />
          </div>
        </section>
        {groups.map((g) => (
          <section key={g}>
            <h2 className="mb-3 text-xs font-semibold tracking-[0.16em] text-muted uppercase">{g}</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {apps
                .filter((a) => a.group === g)
                .map((a) => {
                  const s = STATUS[a.status];
                  return (
                    <Card key={a.slug}>
                      <div className="flex items-start gap-3">
                        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-panel-2 text-sm font-bold">
                          <span className="brand-text">{a.name.replace(/^Google /, "G")[0]}</span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="font-semibold">{a.name}</h3>
                            <Badge tone={s.tone} dot>
                              {s.label}
                            </Badge>
                          </div>
                          <p className="mt-1 text-sm text-muted">{a.use}</p>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        {a.manual ? (
                          <p className="text-xs text-muted">{a.manual}</p>
                        ) : (
                          <>
                            <form action={connectApp.bind(null, a.slug)}>
                              <SubmitButton className={`${a.status === "connected" ? btnGhost : btn} ${btnSm}`} pendingText="Opening…">
                                <Icon name="plug" className="size-3.5" />
                                {a.status === "connected" ? "Reconnect" : a.status === "not_connected" ? "Connect" : "Connect again"}
                              </SubmitButton>
                            </form>
                            {a.status === "connected" && a.accountId && (
                              <form action={disconnectApp.bind(null, a.slug, a.accountId)}>
                                <SubmitButton className={`${btnGhost} ${btnSm}`} pendingText="Disconnecting…">
                                  Disconnect
                                </SubmitButton>
                              </form>
                            )}
                          </>
                        )}
                      </div>
                    </Card>
                  );
                })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
