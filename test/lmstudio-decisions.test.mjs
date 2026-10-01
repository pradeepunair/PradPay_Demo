import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { createLMStudioDecisions } from "../lib/agents/openai-decisions.mjs";
import { DEMO_CATALOG, quoteDemoProduct } from "../lib/a2a/merchant.mjs";

test("one local model can play Buyer and Merchant with separate structured prompts", async () => {
  const requests = [];
  const decisions = createLMStudioDecisions({ modelId: "openai/gpt-oss-20b", fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, headers: options.headers, body });
    const content = requests.length === 1
      ? { productId: "aurora-pro" }
      : { decision: "accept" };
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop",
      message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 } }) };
  } });
  const buyer = await decisions.chooseProduct("Find fictional headphones under $315", DEMO_CATALOG);
  const quote = quoteDemoProduct({ productId: buyer.productId, quantity: 1 });
  const merchant = await decisions.reviewQuote({ productId: buyer.productId, quantity: 1 }, quote);
  assert.equal(buyer.productId, "aurora-pro");
  assert.equal(merchant.decision, "accept");
  assert.equal(quote.totalMinor, 30319);
  assert.equal(requests.length, 2);
  assert(requests.every(({ url, headers, body }) => url === "http://127.0.0.1:1234/v1/chat/completions"
    && !Object.hasOwn(headers, "Authorization") && body.model === "openai/gpt-oss-20b"
    && body.response_format.type === "json_schema" && body.max_tokens === 256
    && body.stream === false && body.messages[0].role === "system"));
  assert.notEqual(requests[0].body.messages[0].content, requests[1].body.messages[0].content);
  assert.deepEqual(requests[0].body.response_format.json_schema.schema.required, ["productId"]);
  assert.deepEqual(requests[1].body.response_format.json_schema.schema.required, ["decision"]);
  await assert.rejects(decisions.chooseProduct("Find fictional headphones under $315", DEMO_CATALOG),
    /MODEL_CALL_LIMIT/);
});

test("local adapter rejects remote endpoints and incomplete output", async () => {
  assert.throws(() => createLMStudioDecisions({ modelId: "local/model", baseUrl: "https://api.openai.com" }),
    /LOCAL_URL_INVALID/);
  assert.throws(() => createLMStudioDecisions({ modelId: "local/model", baseUrl: "http://192.168.1.2:1234" }),
    /LOCAL_URL_INVALID/);
  assert.throws(() => createLMStudioDecisions({ modelId: "" }), /LOCAL_MODEL_ID_REQUIRED/);
  const decisions = createLMStudioDecisions({ modelId: "local/model", fetchImpl: async () => ({
    ok: true, json: async () => ({ choices: [{ finish_reason: "length",
      message: { content: '{"productId":"aurora-pro"}' } }] }),
  }) });
  await assert.rejects(decisions.chooseProduct("Find fictional headphones under $315", DEMO_CATALOG),
    /LOCAL_MODEL_OUTPUT_INVALID/);
});

test("local CLI completes A2A over HTTP without an OpenAI key or paid budget", async (t) => {
  const seen = [];
  const modelServer = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    seen.push({ url: request.url, body });
    const content = seen.length === 1
      ? { productId: "aurora-pro" }
      : { decision: "accept" };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop",
      message: { content: JSON.stringify(content) } }] }));
  });
  try {
    await new Promise((resolve, reject) => {
      modelServer.once("error", reject);
      modelServer.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") { t.skip("loopback listening is unavailable in this sandbox"); return; }
    throw error;
  }
  try {
    const env = { ...process.env, PAYMENTLAB_LOCAL_MODEL_ID: "test/local-model",
      PAYMENTLAB_LOCAL_MODEL_URL: `http://127.0.0.1:${modelServer.address().port}` };
    delete env.OPENAI_API_KEY;
    delete env.PAYMENTLAB_MODEL_BUDGET_LEDGER;
    const child = spawn(process.execPath, ["scripts/a2a-local-model-spike.mjs"], {
      cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.provider, "lmstudio");
    assert.equal(result.taskState, "TASK_STATE_COMPLETED");
    assert.equal(result.providerCalls, 2);
    assert.equal(result.paymentCalls, 0);
    assert.equal(result.budget, null);
    assert.deepEqual(seen.map((request) => request.url),
      ["/v1/chat/completions", "/v1/chat/completions"]);
  } finally { await new Promise((resolve) => modelServer.close(resolve)); }
});
