// Who may do what. Pure functions so they are easy to test; src/lib/session.ts enforces them
// on the server (pages, server actions, route handlers).
//
//   owner: everything
//   team:  everything except money: Payments, the money stats on Home/Dashboard, client billing
//          fields, approving finance or Stripe actions, running the Finance agent, managing people.

export type Role = "owner" | "team";

export type Permission =
  | "payments" // see and change Payments and Expenses, payment history on client pages
  | "money_stats" // MRR, collected, outstanding, overdue on Home and Dashboard
  | "client_billing" // see and edit retainer, VAT, billing method, Stripe customer
  | "approve_finance" // approve or reject finance / Stripe actions
  | "run_finance_agent"
  | "manage_users" // add people, reset passwords, change roles
  | "view_audit"
  | "manage_agents" // create and edit chat agents (instructions, tools, autonomy)
  | "manage_integrations"; // connect and disconnect apps (Gmail, Stripe, Slack…) in Composio

const TEAM: ReadonlySet<Permission> = new Set<Permission>([]);

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (role === "owner") return true;
  if (role === "team") return TEAM.has(permission);
  return false;
}

/** Agents whose actions are about money ("payments" is the finance chat agent). */
const FINANCE_AGENTS = new Set(["finance", "payments"]);

/** 1Media OS tools that read or move money. Team members never get these, in any agent. */
export const MONEY_OS_TOOLS = ["OS_LIST_PAYMENTS", "OS_RECORD_PAYMENT", "OS_GET_RECEIVABLES", "OS_QUEUE_CHASER", "OS_SAVE_CASH_SUMMARY", "OS_LIST_EXPENSES"];

/** True for a tool a team member may not use: the OS money tools, Stripe, and anything about payments or invoices. */
export function isMoneyTool(tool: string): boolean {
  return MONEY_OS_TOOLS.includes(tool.toUpperCase()) || isFinanceAction("", tool);
}

/** True when an approval (or agent action) moves money or touches billing. */
export function isFinanceAction(agent: string, tool: string): boolean {
  const t = tool.toUpperCase();
  return FINANCE_AGENTS.has(agent) || t.startsWith("STRIPE_") || /(^|_)(PAYMENT|PAYMENTS|INVOICE|INVOICES|BILLING|REFUND|PAYOUT)(_|$)/.test(t);
}

/** May this role approve or reject this action? */
export function canDecide(role: Role | null | undefined, agent: string, tool: string): boolean {
  if (!role) return false;
  return isFinanceAction(agent, tool) ? can(role, "approve_finance") : true;
}

/** May this role run this agent? */
export function canRunAgent(role: Role | null | undefined, agent: string): boolean {
  if (!role) return false;
  return FINANCE_AGENTS.has(agent) ? can(role, "run_finance_agent") : true;
}

export class ForbiddenError extends Error {
  constructor(what = "do that") {
    super(`Your account isn't allowed to ${what}. Ask an owner.`);
    this.name = "ForbiddenError";
  }
}
