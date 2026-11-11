// Which outside services are configured. Only ever reports yes/no: never return secret values.

export type IntegrationStatus = { name: string; configured: boolean; detail: string; needs: string[] };

type Env = Record<string, string | undefined>;

const has = (env: Env, k: string) => !!env[k]?.trim();

export function integrationStatus(env: Env = process.env): IntegrationStatus[] {
  const check = (name: string, detail: string, needs: string[], optional: string[] = []) => ({
    name,
    detail,
    needs: [...needs.filter((k) => !has(env, k)), ...optional.filter((k) => !has(env, k)).map((k) => `${k} (optional)`)],
    configured: needs.every((k) => has(env, k)),
  });
  return [
    check("Anthropic", "Agents and Jarvis think with Claude", ["ANTHROPIC_API_KEY"]),
    check("Composio", "Gmail, Calendar, Drive, Meta Ads, GHL, Stripe and Slack tools for agents", ["COMPOSIO_API_KEY"]),
    check("Stripe", "Stripe payments are recorded automatically", ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]),
    check("Slack", "Agent summaries and approval alerts", ["SLACK_WEBHOOK_URL"]),
    check("Notion", "Import clients and payment history (npm run import:notion)", ["NOTION_TOKEN"]),
  ];
}
