/** Posts a message to Slack via an incoming webhook. No-op when SLACK_WEBHOOK_URL isn't set. */
export async function notify(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  } catch (err) {
    console.error("Slack notify failed:", err);
  }
}
