import type { AgentDefinition } from "../types";
import { prompt } from "./prompt";

export const inbox: AgentDefinition = {
  name: "inbox",
  title: "Inbox",
  description: "Sorts Gmail by client, turns requests into tasks, writes an inbox note on each client's page, and queues reply drafts for approval.",
  prompt,
  autonomy: "L2",
  toolkits: ["gmail"],
  // Replies go through GMAIL_REPLY_TO_THREAD, which L2 always turns into an approval.
  // Every other way of sending mail is removed so nothing can bypass that.
  excludeTools: [/^GMAIL_SEND/, /FORWARD/, /^GMAIL_.*(DELETE|TRASH|SPAM)/, /^GMAIL_.*(FILTER|SETTINGS|FORWARDING|VACATION)/],
  osTools: ["OS_LIST_CLIENTS", "OS_LIST_TASKS", "OS_CREATE_TASK", "OS_SAVE_BRIEF"],
  effort: "medium",
  maxTurns: 60,
  task: ({ today }) =>
    `Today is ${today}. Process unread inbox email from the last 24 hours that doesn't have the "1M/Processed" label yet. Add "1M/Processed" to each email when you're done with it.`,
};
