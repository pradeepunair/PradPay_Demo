import assert from "node:assert/strict";
import test from "node:test";

import { runLocalA2A } from "../lib/demo/local-a2a.mjs";
import { projectProtocolEvidence } from "../lib/demo/protocol-evidence.mjs";

test("an SDK Buyer-to-Merchant exchange retains only an observed, redacted protocol trace", async (t) => {
  const decisions = { callsUsed: 2,
    chooseProduct: async () => ({ productId: "aurora-pro", model: "fixture-buyer", reason: "Selected" }),
    reviewQuote: async () => ({ decision: "accept", model: "fixture-merchant", reason: "Accepted" }) };
  let result;
  try { result = await runLocalA2A({ decisions }); }
  catch (error) {
    if (error?.code === "EPERM") { t.skip("loopback listening is unavailable"); return; }
    throw error;
  }
  assert.equal(result.taskState, "TASK_STATE_COMPLETED");
  assert.equal(result.paymentCalls, 0);
  assert.equal(result.protocolEvidence.agentCard.binding, "JSONRPC");
  assert.equal(result.protocolEvidence.buyerMessage.productId, result.quote.productId);
  assert.equal(result.protocolEvidence.merchantTask.state, "completed");
  assert.match(result.protocolEvidence.merchantTask.taskIdSuffix, /^[A-Za-z0-9_-]{8}$/);
  assert(!JSON.stringify(result.protocolEvidence).includes("127.0.0.1"));
});

test("the session projection strips unapproved fields and rejects forged protocol claims", () => {
  const observed = { version: 1, source: "observed_a2a_sdk",
    agentCard: { protocolVersion: "1.0", binding: "JSONRPC", skillId: "quote_demo_product",
      url: "http://127.0.0.1:1234/secret" },
    buyerMessage: { role: "user", messageIdSuffix: "12345678", productId: "aurora-pro",
      quantity: 1, prompt: "private" },
    merchantTask: { taskIdSuffix: "87654321", state: "completed",
      artifactIdSuffix: "abcdefgh", artifact: "Quote", outcome: "quoted", token: "spt_private" },
    secret: "sk_test_private" };
  const projected = projectProtocolEvidence(observed);
  assert.equal(projected.agentCard.name, "PradPay Test Merchant");
  assert.equal(projected.buyerMessage.productId, "aurora-pro");
  assert(!JSON.stringify(projected).includes("private"));
  assert.equal(projectProtocolEvidence({ ...observed, source: "synthetic" }), null);
  assert.equal(projectProtocolEvidence({ ...observed,
    merchantTask: { ...observed.merchantTask, outcome: "refused" } }), null);
});
