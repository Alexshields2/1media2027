/** Posts a message to Slack via an incoming webhook. Returns true when posted; no-op (false) when SLACK_WEBHOOK_URL isn't set. */
export async function notify(text: string): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    return res.ok;
  } catch (err) {
    console.error("Slack notify failed:", err);
    return false;
  }
}
