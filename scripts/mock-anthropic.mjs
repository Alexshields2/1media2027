// A stand-in for the Anthropic Messages API, for testing agents end to end without a key.
//   node scripts/mock-anthropic.mjs            (listens on :4010)
//   ANTHROPIC_BASE_URL=http://localhost:4010 ANTHROPIC_API_KEY=test npm start
// First turn of a conversation asks for OS_LIST_PAYMENTS; the next turn answers in markdown.
// A question containing "fail" returns a 529 overloaded error so the failure path can be seen.
// Requests with "stream": true (the chat) get the same reply as server-sent events.
import { createServer } from "node:http";

const port = Number(process.env.PORT || 4010);
const delayMs = Number(process.env.MOCK_DELAY_MS || 1500);
const usage = { input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    if (!req.url?.startsWith("/v1/messages")) return send(res, 404, { type: "error", error: { type: "not_found_error", message: req.url } });
    const msg = JSON.parse(body || "{}");
    const first = msg.messages?.[0]?.content;
    const question = typeof first === "string" ? first : JSON.stringify(first);
    // In a chat, a turn is "first" when the last message is the person's (not tool results).
    const last = msg.messages?.at(-1)?.content;
    const toolTurn = Array.isArray(last) && last.some((b) => b.type === "tool_result");
    await new Promise((r) => setTimeout(r, delayMs));
    if (/fail/i.test(question)) return send(res, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded (mock)" } });
    const turn = msg.stream ? (toolTurn ? 2 : 1) : msg.messages.length;
    const content =
      turn === 1
        ? [{ type: "tool_use", id: `toolu_mock_${Date.now()}`, name: "OS_LIST_PAYMENTS", input: { filter: "outstanding" } }]
        : [
            {
              type: "text",
              text: "## Who owes us money\n\nTwo clients are **overdue**:\n\n| Client | Owed | Days late |\n|---|---:|---:|\n| Demo Roofing | €1,845.00 | 12 |\n| Demo Windows | €984.00 | 5 |\n\n- Chase **Demo Roofing** first.\n- Everyone else is paid up.",
            },
          ];
    const reply = {
      id: `msg_mock_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: msg.model,
      content,
      stop_reason: turn === 1 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage,
    };
    if (msg.stream) return stream(res, reply);
    send(res, 200, reply);
  });
}).listen(port, () => console.log(`mock anthropic on :${port}`));

function send(res, status, json) {
  res.writeHead(status, { "content-type": "application/json", "request-id": "req_mock" });
  res.end(JSON.stringify(json));
}

/** Writes a reply as Messages API server-sent events, text in small chunks. */
async function stream(res, reply) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_mock" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { ...reply, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
  for (const [index, block] of reply.content.entries()) {
    if (block.type === "text") {
      ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const chunk of block.text.match(/[\s\S]{1,16}/g) ?? []) {
        ev("content_block_delta", { index, delta: { type: "text_delta", text: chunk } });
        await new Promise((r) => setTimeout(r, 15));
      }
    } else {
      ev("content_block_start", { index, content_block: { ...block, input: {} } });
      ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    ev("content_block_stop", { index });
  }
  ev("message_delta", { delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  ev("message_stop", {});
  res.end();
}
