import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { quoteDemoProduct } from "../lib/a2a/merchant.mjs";
import { createLocalJourney } from "../lib/demo/local-journey.mjs";
import { createLocalJourneyHandlers } from "../lib/demo/local-journey-api.mjs";

async function fixture({ pay, paymentEnabled = true, now = () => Date.now() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "paymentlab-local-journey-"));
  await chmod(dir, 0o700);
  const env = { PAYMENTLAB_ENVIRONMENT: "local", PAYMENTLAB_LOCAL_DEMO_ENABLE: "1",
    PAYMENTLAB_LOCAL_DEMO_STATE_DIR: dir,
    PAYMENTLAB_LOCAL_STRIPE_PAYMENT_ENABLE: paymentEnabled ? "1" : "0", STRIPE_SECRET_KEY: "sk_test_fixture", PAYMENTLAB_STRIPE_ACCOUNT_ID: "acct_demofixture0001" };
  const quote = quoteDemoProduct({ productId: "aurora-pro", quantity: 1 });
  const receipt = { provider: "lmstudio", protocol: "A2A 1.0 JSON-RPC", taskState: "TASK_STATE_COMPLETED",
    protocolEvidence: { version: 1, source: "observed_a2a_sdk",
      agentCard: { protocolVersion: "1.0", binding: "JSONRPC", skillId: "quote_demo_product" },
      buyerMessage: { role: "user", messageIdSuffix: "12345678", productId: "aurora-pro", quantity: 1 },
      merchantTask: { taskIdSuffix: "87654321", state: "completed",
        artifactIdSuffix: "abcdefgh", artifact: "Quote", outcome: "quoted" } },
    buyer: { model: "local", selectedProductId: "aurora-pro", reason: "Selected" },
    merchant: { model: "local", reason: "Accepted" }, quote, providerCalls: 2, paymentCalls: 0 };
  const service = createLocalJourney({ env, now, runA2A: async () => receipt,
    pay: pay ?? (async () => ({ paymentStatus: "succeeded", accountId: "acct_test", paymentIntentSuffix: "fixture",
      sptIssuance: "seller_test_helper_simulated" })) });
  return { dir, env, quote, service, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("exact approval persists and allows one payment dispatch across repeated calls", async () => {
  let calls = 0;
  const f = await fixture({ pay: async () => { calls++; return { paymentStatus: "succeeded" }; } });
  try {
    const { token, snapshot } = await f.service.start();
    assert.equal(snapshot.state, "quoted");
    assert.equal(snapshot.protocolEvidence.buyerMessage.productId, "aurora-pro");
    await assert.rejects(f.service.approve(snapshot.id, token, { quoteId: f.quote.quoteId,
      totalMinor: 100 }), /QUOTE_EXPIRED_OR_CHANGED/);
    assert.equal((await f.service.approve(snapshot.id, token, { quoteId: f.quote.quoteId,
      totalMinor: f.quote.totalMinor })).state, "approved");
    assert.equal((await f.service.pay(snapshot.id, token, f.env.STRIPE_SECRET_KEY)).state, "succeeded");
    await assert.rejects(f.service.pay(snapshot.id, token, f.env.STRIPE_SECRET_KEY),
      /PAYMENT_ALREADY_RESERVED_OR_NOT_APPROVED/);
    assert.equal(calls, 1);
    const reread = await f.service.read(snapshot.id, token);
    assert.equal(reread.state, "succeeded");
    assert.equal(reread.protocolEvidence.merchantTask.taskIdSuffix, "87654321");
    await assert.rejects(f.service.read(snapshot.id, "00000000-0000-0000-0000-000000000000"), /RUN_NOT_FOUND/);
    const stored = JSON.parse(await readFile(join(f.dir, `${snapshot.id}.json`), "utf8"));
    assert.equal(stored.state, "succeeded");
  } finally { await f.cleanup(); }
});

test("expired quote and disabled payment never dispatch", async () => {
  let calls = 0;
  let clock = Date.now();
  const f = await fixture({ paymentEnabled: false, now: () => clock,
    pay: async () => { calls++; } });
  try {
    const { token, snapshot } = await f.service.start();
    clock = Date.parse(f.quote.expiresAt) + 1;
    await assert.rejects(f.service.approve(snapshot.id, token, { quoteId: f.quote.quoteId,
      totalMinor: f.quote.totalMinor }), /QUOTE_EXPIRED_OR_CHANGED/);
    clock = Date.now();
    await f.service.approve(snapshot.id, token, { quoteId: f.quote.quoteId, totalMinor: f.quote.totalMinor });
    await assert.rejects(f.service.pay(snapshot.id, token, f.env.STRIPE_SECRET_KEY), /SANDBOX_PAYMENT_DISABLED/);
    const enabledAfterRestart = createLocalJourney({ env: { ...f.env,
      PAYMENTLAB_LOCAL_STRIPE_PAYMENT_ENABLE: "1" }, now: () => clock,
    pay: async () => { calls++; } });
    await assert.rejects(enabledAfterRestart.pay(snapshot.id, token, f.env.STRIPE_SECRET_KEY),
      /SANDBOX_PAYMENT_DISABLED/);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test("uncertain provider response records a terminal no-retry state", async () => {
  let calls = 0;
  const f = await fixture({ pay: async () => { calls++; throw new Error("lost response"); } });
  try {
    const { token, snapshot } = await f.service.start();
    await f.service.approve(snapshot.id, token, { quoteId: f.quote.quoteId, totalMinor: f.quote.totalMinor });
    assert.equal((await f.service.pay(snapshot.id, token, f.env.STRIPE_SECRET_KEY)).state, "payment_uncertain");
    await assert.rejects(f.service.pay(snapshot.id, token, f.env.STRIPE_SECRET_KEY));
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test("HTTP boundary requires local configuration and same-origin approval", async () => {
  const f = await fixture();
  try {
    const handlers = createLocalJourneyHandlers({ env: f.env, service: f.service });
    const crossOrigin = await handlers.start(new Request("http://127.0.0.1:3000/api/local-demo",
      { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://evil.test" } }));
    assert.equal(crossOrigin.status, 403);
    const normalized = await handlers.start(new Request("http://localhost:3000/api/local-demo",
      { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }));
    assert.equal(normalized.status, 201);
    const remote = await handlers.start(new Request("https://example.com/api/local-demo",
      { method: "POST", headers: { host: "example.com", origin: "https://example.com" } }));
    assert.equal(remote.status, 503);
    const disabled = createLocalJourneyHandlers({ env: {} });
    assert.equal((await disabled.start(new Request("http://127.0.0.1:3000/api/local-demo",
      { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }))).status, 503);
  } finally { await f.cleanup(); }
});
