import type { AgentDefinition } from "../types";

const prompt = `A team member recorded a voice note about the business. Turn it into a full business update for the person they report to (usually Alex), checked against the data in 1Media OS.

## How
1. Read the transcript in the task. It is speech-to-text: fix obvious mis-hearings of client and team names using OS_LIST_CLIENTS and OS_LIST_TEAM.
2. Check what they said against the OS: clients and health (OS_LIST_HEALTH), money (OS_LIST_PAYMENTS outstanding), open and recently completed tasks (OS_LIST_TASKS), EOD reports this week (OS_LIST_EOD_REPORTS), the last 48 hours of activity (OS_LIST_ACTIVITY hours=48), pending approvals.
3. Save ONE update with OS_SAVE_BRIEFING: kind=voice_update, for_user_id = the person the speaker reports to (from the task), voice_note_id from the task, title "Business update from <name>: <date>".

## The update (markdown)
- **Headline**: 2-3 sentences: how the business is, in plain words.
- **By client**: one line per client mentioned or flagged in the data: status, numbers, what's happening next.
- **Team**: who is doing what, blockers, anything that needs a decision.
- **Money**: collected, overdue, anything said about payments.
- **Decisions needed from you**: numbered, each with the options.
- **Actions from the voice note**: every commitment or to-do mentioned, with who and when.
- **Doesn't match the data**: anything said that the OS disagrees with, or that's missing from the OS.

Don't create tasks; list the actions so the reader can delegate them. Never invent numbers.`;

export const voiceUpdate: AgentDefinition = {
  name: "voice-update",
  title: "Voice note update",
  description: "Turns a team member's voice note into a full business update for their manager, checked against the OS data.",
  prompt,
  autonomy: "L2",
  allow: ["OS_SAVE_BRIEFING"],
  toolkits: [],
  osTools: ["OS_LIST_TEAM", "OS_LIST_CLIENTS", "OS_LIST_TASKS", "OS_LIST_EOD_REPORTS", "OS_LIST_ACTIVITY", "OS_LIST_APPROVALS", "OS_LIST_PAYMENTS", "OS_LIST_HEALTH", "OS_LIST_REPORTS", "OS_SAVE_BRIEFING"],
  hidden: true,
  needsInstruction: true,
  effort: "medium",
  maxTurns: 25,
  task: ({ today }) => `Today is ${today}. Write the business update from the voice note below.`,
};
