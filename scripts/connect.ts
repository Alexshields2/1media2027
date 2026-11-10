import { config } from "../src/config.js";
import { composio, TOOLKITS } from "../src/lib/composio.js";

// Connect 1Media's accounts to Composio, once.
//   npm run connect            -> show what's connected and print a login link for each missing toolkit
//   npm run connect -- gmail   -> print a login link for one toolkit
//
// Open each link, log in with the 1Media account, done. Agents then use that connection.

async function main() {
  const c = composio();
  const userId = config.composioUserId;
  const only = process.argv[2];
  const wanted = only ? [only] : Object.values(TOOLKITS);

  const existing = await c.connectedAccounts.list({ userIds: [userId] });
  const connected = new Set(
    existing.items
      .filter((a) => a.status === "ACTIVE")
      .map((a) => a.toolkit.slug.toLowerCase()),
  );

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
  console.log("\nOpen each link and log in. Run this again to check everything shows ✓.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
