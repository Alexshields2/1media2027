import "../src/config";
import { createServer } from "node:http";
import { ACTION_APPROVE, ACTION_REJECT, signSlackRequest } from "../src/lib/slack-app";

// Sends a signed fake Slack request to a running 1Media OS and prints what comes back,
// including the delayed message Slack would receive on response_url.
//
//   SLACK_SIGNING_SECRET=test SLACK_ALLOW_LOCAL_RESPONSE_URL=true npm start      (in one terminal)
//   SLACK_SIGNING_SECRET=test npm run slack:fake -- jarvis "who owes us money?"
//   SLACK_SIGNING_SECRET=test npm run slack:fake -- approve 3
//   SLACK_SIGNING_SECRET=test npm run slack:fake -- reject 3
//
// APP=http://localhost:3000 by default. Never point this at production.

const [kind, arg] = process.argv.slice(2);
const app = (process.env.APP ?? "http://localhost:3000").replace(/\/$/, "");
const secret = process.env.SLACK_SIGNING_SECRET;
if (!secret || !kind || !arg) {
  console.error('Usage: SLACK_SIGNING_SECRET=... tsx scripts/slack-fake.ts jarvis "<question>" | approve <id> | reject <id>');
  process.exit(1);
}

const port = 4599;
const responseUrl = `http://localhost:${port}/response`;
const waitMs = Number(process.env.WAIT_MS ?? 120_000);

const delayed = new Promise<unknown>((resolve) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.end("ok");
      server.close();
      resolve(JSON.parse(body));
    });
  }).listen(port);
  setTimeout(() => {
    server.close();
    resolve("(nothing posted to response_url)");
  }, waitMs).unref();
});

const body =
  kind === "jarvis"
    ? new URLSearchParams({ command: "/jarvis", text: arg, user_id: "U_LOCAL", user_name: "local-test", team_id: "T_LOCAL", response_url: responseUrl }).toString()
    : new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          user: { id: "U_LOCAL", username: "local-test" },
          team: { id: "T_LOCAL" },
          response_url: responseUrl,
          actions: [{ action_id: kind === "approve" ? ACTION_APPROVE : ACTION_REJECT, value: arg }],
        }),
      }).toString();

const ts = String(Math.floor(Date.now() / 1000));
const t0 = Date.now();
const res = await fetch(`${app}/api/slack`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": signSlackRequest(secret, ts, body) },
  body,
});
console.log(`HTTP ${res.status} in ${Date.now() - t0} ms:`, (await res.text()) || "(empty)");
console.log("response_url got:", JSON.stringify(await delayed, null, 2));
