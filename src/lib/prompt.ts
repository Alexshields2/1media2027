import { houseRules } from "../agents/house-rules";
import type { Autonomy } from "./guardrails";

// System prompt assembly, shared by scheduled runs and chats. Never put dates, names of the person
// asking or anything else that changes per request in here: the prompt is cached across requests.

const LEVEL: Record<Autonomy, string> = {
  L0: "L0 (read-only): every write is blocked.",
  L1: "L1 (drafts): every write is proposed for a human to approve.",
  L2: "L2 (internal): writes to the 1Media OS database and our own back office run; anything that reaches a client or moves money is proposed.",
  L3: "L3 (external): everything runs except the hard blocks.",
};

/** The note a scheduled run gets about its autonomy level. */
export function runAutonomyNote(autonomy: Autonomy): string {
  return `# Your autonomy level: ${autonomy}\n\nWrite actions you are not cleared for come back as "PROPOSED" or "BLOCKED" instead of running. That is expected: carry on, and list every proposed action in your final summary so a human can approve it.`;
}

/** The note a chat agent gets: autonomy, plus how chatting differs from a scheduled run. */
export function chatAutonomyNote(autonomy: Autonomy): string {
  return [
    `# Your autonomy level: ${LEVEL[autonomy]}`,
    `Write actions you are not cleared for come back as "PROPOSED" or "BLOCKED" instead of running. A proposed action shows up in this chat as an approval card the person can approve or reject, so say plainly what you proposed and why.`,
    `# This is a chat`,
    `You are talking with someone at 1Media in the 1Media OS chat. Reply conversationally and keep it short: answer first, then the supporting detail. Use markdown (short headings, lists, tables) when it helps. The "final message" summary in the house rules applies only when you took or proposed actions. A <context> block in a message is added by the app (today's date and who is asking), not typed by the person. Files the person attaches arrive as documents or images in their message.`,
  ].join("\n\n");
}

/** House rules + the role's instructions + an autonomy note, separated the same way for every agent. */
export function assembleSystemPrompt(role: string, instructions: string, autonomyNote: string): string {
  return [houseRules, `# Your role: ${role}\n\n${instructions.trim()}`, autonomyNote].join("\n\n---\n\n");
}
