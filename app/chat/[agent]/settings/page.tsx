import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { canEditProfiles } from "@/lib/chat/access";
import { DEFAULT_BY_SLUG, getProfile } from "@/lib/chat/profiles";
import { NoAccess, PageHeader, btnGhost } from "../../../_components/ui";
import { SubmitButton } from "../../../_components/client-bits";
import { AgentAvatar } from "../../_components/agent-icon";
import { AgentForm } from "../../_components/agent-form";
import { resetProfileAction, saveProfile } from "../../actions";
import { formOptions, formValues } from "../../agent-options";

export const dynamic = "force-dynamic";

export default async function AgentSettingsPage({ params, searchParams }: { params: Promise<{ agent: string }>; searchParams: Promise<{ reset?: string }> }) {
  const user = await requireUser();
  if (!canEditProfiles(user.role)) return <NoAccess what="Editing agents" />;
  const { agent } = await params;
  const profile = await getProfile(agent);
  if (!profile) notFound();
  const isDefault = !!DEFAULT_BY_SLUG[profile.slug];
  const sp = await searchParams;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        icon={<AgentAvatar icon={profile.icon} size="lg" />}
        title={`${profile.name} settings`}
        subtitle={
          <>
            What this agent knows and may do in chats. <span className="text-ink/40">/chat/{profile.slug}</span>
          </>
        }
        actions={
          <>
            <Link href={`/chat/${profile.slug}`} className={btnGhost}>
              Back to chat
            </Link>
            {isDefault && (
              <form action={resetProfileAction.bind(null, profile.slug)}>
                <SubmitButton className={btnGhost} pendingText="Resetting…">
                  Reset to default
                </SubmitButton>
              </form>
            )}
          </>
        }
      />
      {sp.reset && <p className="mb-4 rounded-lg bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">Reset to the default instructions and tools.</p>}
      <AgentForm
        key={profile.updatedAt.toISOString()}
        action={saveProfile.bind(null, profile.slug)}
        initial={formValues(profile)}
        {...formOptions()}
        lockOwnerOnly={profile.slug === "payments"}
        submitLabel="Save changes"
      />
    </div>
  );
}
