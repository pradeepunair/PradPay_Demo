// This is an allowlisted description of the observed A2A exchange, not a raw
// protocol or model transcript. It contains no endpoint, token, prompt, or card
// payload and is safe to include in a session-scoped run snapshot.
const suffix = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value)
  ? value.slice(-8) : null;
const product = (value) => typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value)
  ? value : null;

export function projectProtocolEvidence(input) {
  if (input?.version !== 1 || input?.source !== "observed_a2a_sdk"
    || input.agentCard?.protocolVersion !== "1.0"
    || input.agentCard?.binding !== "JSONRPC"
    || input.agentCard?.skillId !== "quote_demo_product"
    || input.buyerMessage?.role !== "user"
    || input.buyerMessage?.quantity !== 1
    || input.merchantTask?.state !== "completed"
    || input.merchantTask?.artifact !== "Quote"
    || input.merchantTask?.outcome !== "quoted") return null;
  const messageIdSuffix = suffix(input.buyerMessage.messageIdSuffix);
  const taskIdSuffix = suffix(input.merchantTask.taskIdSuffix);
  const artifactIdSuffix = suffix(input.merchantTask.artifactIdSuffix);
  const productId = product(input.buyerMessage.productId);
  if (!messageIdSuffix || !taskIdSuffix || !artifactIdSuffix || !productId) return null;
  return {
    version: 1, source: "observed_a2a_sdk",
    agentCard: { name: "PradPay Test Merchant", protocolVersion: "1.0",
      binding: "JSONRPC", skillId: "quote_demo_product" },
    buyerMessage: { role: "user", messageIdSuffix, productId, quantity: 1 },
    merchantTask: { taskIdSuffix, state: "completed", artifactIdSuffix,
      artifact: "Quote", outcome: "quoted" },
  };
}

export function protocolEvidenceFromExchange({ card, messageId, task, productId, quote }) {
  if (card?.skills?.[0]?.id !== "quote_demo_product"
    || card?.supportedInterfaces?.[0]?.protocolBinding !== "JSONRPC"
    || card?.supportedInterfaces?.[0]?.protocolVersion !== "1.0"
    || task?.status?.state === undefined || quote?.outcome !== "quoted"
    || quote?.productId !== productId) throw new Error("A2A_EVIDENCE_INVALID");
  const evidence = projectProtocolEvidence({
    version: 1, source: "observed_a2a_sdk",
    agentCard: { protocolVersion: "1.0", binding: "JSONRPC", skillId: "quote_demo_product" },
    buyerMessage: { role: "user", messageIdSuffix: suffix(messageId), productId, quantity: 1 },
    merchantTask: { taskIdSuffix: suffix(task.id), state: "completed",
      artifactIdSuffix: suffix(task.artifacts?.[0]?.artifactId),
      artifact: task.artifacts?.[0]?.name, outcome: quote.outcome },
  });
  if (!evidence) throw new Error("A2A_EVIDENCE_INVALID");
  return evidence;
}
