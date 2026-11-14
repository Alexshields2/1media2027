import Link from "next/link";
import { requireUser } from "@/lib/session";
import { canEditProfiles } from "@/lib/chat/access";
import { NoAccess, PageHeader, btnGhost } from "../../_components/ui";
import { AgentAvatar } from "../_components/agent-icon";
import { AgentForm } from "../_components/agent-form";
import { createProfile } from "../actions";
import { formOptions } from "../agent-options";

export const dynamic = "force-dynamic";

export default async function NewAgentPage() {
  const user = await requireUser();
  if (!canEditProfiles(user.role)) return <NoAccess what="Creating agents" />;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        icon={<AgentAvatar icon="star" size="lg" />}
        title="Create agent"
        subtitle="A new chat agent with your own instructions. It starts read-only; give it tools below."
        actions={
          <Link href="/chat" className={btnGhost}>
            Cancel
          </Link>
        }
      />
      <AgentForm
        action={createProfile}
        initial={{ name: "", icon: "star", description: "", instructions: "", baseAgent: "", toolkits: [], osTools: ["OS_LIST_CLIENTS", "OS_LIST_TASKS"], autonomy: "L0", webSearch: false, ownerOnly: false, active: true }}
        {...formOptions()}
        submitLabel="Create agent"
      />
    </div>
  );
}
