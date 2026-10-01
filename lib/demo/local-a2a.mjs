import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { A2A_PROTOCOL_VERSION, Role, TaskState } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { createLMStudioDecisions } from "../agents/openai-decisions.mjs";
import { createMerchantA2A, DEMO_CATALOG } from "../a2a/merchant.mjs";
import { protocolEvidenceFromExchange } from "./protocol-evidence.mjs";

export const LOCAL_DEMO_MISSION = "Choose one in-stock pair of wireless headphones under $315 for a fictional buyer.";

export async function runLocalA2A({ decisions = createLMStudioDecisions({
  modelId: process.env.PAYMENTLAB_LOCAL_MODEL_ID,
  baseUrl: process.env.PAYMENTLAB_LOCAL_MODEL_URL || "http://127.0.0.1:1234",
  apiToken: process.env.LM_STUDIO_API_TOKEN || undefined,
}), mission = LOCAL_DEMO_MISSION } = {}) {
  let merchant;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(merchant.card));
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/a2a/merchant"
      || req.headers["a2a-version"] !== A2A_PROTOCOL_VERSION) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) { res.writeHead(413).end(); return; }
    }
    try {
      const response = await merchant.transport.handle(body,
        new ServerCallContext({ requestedVersion: A2A_PROTOCOL_VERSION }));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(response));
    } catch { res.writeHead(503).end(JSON.stringify({ code: "A2A_UNAVAILABLE" })); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  merchant = createMerchantA2A(baseUrl, { reviewQuote: (request, quote) => decisions.reviewQuote(request, quote) });
  try {
    const buyer = await decisions.chooseProduct(mission, DEMO_CATALOG);
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory()] }).createFromUrl(baseUrl);
    const messageId = randomUUID();
    const task = await client.sendMessage({ message: {
      role: Role.ROLE_USER, messageId,
      parts: [{ content: { $case: "text", value: JSON.stringify({ productId: buyer.productId, quantity: 1 }) },
        mediaType: "text/plain" }],
    } }, { signal: AbortSignal.timeout(75_000) });
    const part = task?.artifacts?.[0]?.parts?.[0];
    if (part?.content?.$case !== "text") throw new Error("A2A_ARTIFACT_MISSING");
    const quote = JSON.parse(part.content.value);
    if (task.status.state !== TaskState.TASK_STATE_COMPLETED || quote.outcome !== "quoted") {
      throw new Error(quote.reason ?? "A2A_QUOTE_REFUSED");
    }
    const protocolEvidence = protocolEvidenceFromExchange({ card: merchant.card,
      messageId, task, productId: buyer.productId, quote });
    return { provider: "lmstudio", protocol: "A2A 1.0 JSON-RPC",
      taskState: TaskState[task.status.state], protocolEvidence,
      buyer: { model: buyer.model,
        selectedProductId: buyer.productId, reason: buyer.reason, usage: buyer.usage },
      merchant: quote.merchantReview, quote, providerCalls: decisions.callsUsed, paymentCalls: 0 };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
