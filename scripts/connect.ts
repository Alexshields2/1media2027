import { config } from "../src/config";
import { composio, TOOLKITS } from "../src/lib/composio";

// Connect 1Media's accounts (Gmail, Meta, GHL, Stripe…) to Composio, once.
//   npm run connect            -> shows what's connected, prints a login link for the rest
//   npm run connect -- gmail   -> a login link for one app

async function main() {
  const c = composio();
  const userId = config.composioUserId;
  const only = process.argv[2];
  const wanted = only ? [only] : Object.values(TOOLKITS);
  const existing = await c.connectedAccounts.list({ userIds: [userId] });
  const connected = new Set(existing.items.filter((a) => a.status === "ACTIVE").map((a) => a.toolkit.slug.toLowerCase()));

  console.log(`Composio user: ${userId}\n`);
  for (const slug of wanted) {
    if (connected.has(slug) && !only) {
      console.log(`  ✓ ${slug}`);
      continue;
    }
    try {
      const req = await c.toolkits.authorize(userId, slug);
      console.log(`  → ${slug}: ${req.redirectUrl}`);
    } catch (err) {
      console.log(`  ✗ ${slug}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log("\nOpen each link and log in with the 1Media account. Run again to check everything shows ✓.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
