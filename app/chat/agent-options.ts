import { AGENT_LIST } from "@/agents/registry";
import { TOOLKITS } from "@/lib/composio";
import { osToolDefs } from "@/lib/os-tools";
import { isMoneyTool } from "@/lib/roles";
import { isRead } from "@/lib/guardrails";
import type { AgentProfile } from "@/db/schema";
import type { AgentFormValues, Option } from "./_components/agent-form";

const APP_NAMES: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googlesheets: "Google Sheets",
  googledocs: "Google Docs",
  metaads: "Meta Ads (read-only)",
  facebook: "Facebook",
  highlevel: "GoHighLevel",
  stripe: "Stripe",
  slack: "Slack",
  whatsapp: "WhatsApp",
};

export function formOptions(): { bases: Option[]; toolkits: Option[]; osTools: Option[] } {
  return {
    bases: AGENT_LIST.map((a) => ({ value: a.name, label: a.title })),
    toolkits: Object.values(TOOLKITS).map((t) => ({ value: t, label: APP_NAMES[t] ?? t, money: t === "stripe" })),
    osTools: osToolDefs().map((t) => ({
      value: t.name,
      label: t.name.replace(/^OS_/, "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      hint: `${isRead(t.name) && !/_(SAVE|CREATE|RECORD|QUEUE)_/.test(t.name) ? "Read" : "Write"} · ${(t.description ?? "").split(". ")[0].slice(0, 90)}`,
      money: isMoneyTool(t.name),
    })),
  };
}

export function formValues(p: AgentProfile): AgentFormValues {
  return {
    name: p.name,
    icon: p.icon,
    description: p.description,
    instructions: p.instructions,
    baseAgent: p.baseAgent ?? "",
    toolkits: p.toolkits,
    osTools: p.osTools,
    autonomy: p.autonomy,
    webSearch: p.webSearch,
    ownerOnly: p.ownerOnly,
    active: p.active,
  };
}
