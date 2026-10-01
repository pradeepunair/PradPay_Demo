import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Stripe from "stripe";

import { quoteDemoProduct } from "../lib/a2a/merchant.mjs";
import { createLocalJourney } from "../lib/demo/local-journey.mjs";
import { createLocalJourneyHandlers } from "../lib/demo/local-journey-api.mjs";

const secret = "whsec_local_fixture";
const paymentId = "pi_localfixture";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const response = (body) => new Response(JSON.stringify(body), { status: 200 });

async function fixture({ knownPaymentId = true, list = [], accountId = "acct_demofixture0001",
  deferPayment = false, payImpl } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "paymentlab-webhook-"));
  await chmod(dir, 0o700);
  const env = { PAYMENTLAB_ENVIRONMENT: "local", PAYMENTLAB_LOCAL_DEMO_ENABLE: "1",
    PAYMENTLAB_LOCAL_DEMO_STATE_DIR: dir, PAYMENTLAB_LOCAL_STRIPE_PAYMENT_ENABLE: "1",
    PAYMENTLAB_LOCAL_WEBHOOK_ENABLE: "1", STRIPE_SECRET_KEY: "sk_test_fixture", PAYMENTLAB_STRIPE_ACCOUNT_ID: "acct_demofixture0001", STRIPE_WEBHOOK_SECRET: secret };
  const quote = quoteDemoProduct({ productId: "aurora-pro", quantity: 1 });
  const receipt = { provider: "lmstudio", protocol: "A2A 1.0 JSON-RPC", taskState: "TASK_STATE_COMPLETED",
    buyer: { model: "local", selectedProductId: "aurora-pro" }, merchant: { model: "local" },
    quote, paymentCalls: 0 };
  const quoteHash = sha(JSON.stringify(quote));
  const calls = [];
  let runId;
  function intent(overrides = {}) {
    return { id: paymentId, object: "payment_intent", livemode: false, amount: quote.totalMinor,
      amount_received: quote.totalMinor, currency: "usd", status: "succeeded", payment_method: "pm_localfixture",
      metadata: { paymentlab_demo: "local_a2a_spt_helper", paymentlab_product_id: quote.productId,
        paymentlab_run_id: runId, paymentlab_quote_hash: quoteHash }, ...overrides };
  }
  const fetchImpl = async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method });
    if (new URL(url).pathname === "/v1/account") return response({ id: accountId, country: "US" });
    if (new URL(url).pathname === `/v1/payment_intents/${paymentId}`) return response(intent());
    if (new URL(url).pathname === "/v1/payment_intents") return response({ data: list.map((value) => intent(value)), has_more: false });
    throw new Error("unexpected Stripe path");
  };
  const service = createLocalJourney({ env, runA2A: async () => receipt, fetchImpl,
    pay: payImpl ?? (async ({ attemptPath, runId: id }) => {
      runId = id;
      await writeFile(attemptPath, JSON.stringify({ runId: id, amountMinor: quote.totalMinor,
        currency: "usd", quoteHash, state: "payment_uncertain_or_rejected",
        ...(knownPaymentId ? { paymentIntentId: paymentId } : {}) }), { mode: 0o600 });
      throw new Error("simulated lost response");
    }) });
  const { token, snapshot } = await service.start();
  runId = snapshot.id;
  await service.approve(runId, token, { quoteId: quote.quoteId, totalMinor: quote.totalMinor });
  if (!deferPayment) assert.equal((await service.pay(runId, token, env.STRIPE_SECRET_KEY)).state, "payment_uncertain");
  function signedEvent({ id = "evt_localfixture", type = "payment_intent.succeeded", object = intent(), livemode = false } = {}) {
    const payload = JSON.stringify({ id, object: "event", created: Math.floor(Date.now() / 1000),
      livemode, type, data: { object } });
    return { rawBody: Buffer.from(payload), signature: Stripe.webhooks.generateTestHeaderString({ payload, secret }),
      endpointSecret: secret };
  }
  return { dir, env, service, token, runId, quote, quoteHash, calls, intent, signedEvent,
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a signed, matching Stripe success resolves an uncertain run once", async () => {
  const f = await fixture();
  try {
    const signed = f.signedEvent();
    assert.deepEqual(await f.service.receiveWebhook(signed), { disposition: "recorded" });
    assert.deepEqual(await f.service.receiveWebhook(signed), { disposition: "duplicate" });
    await assert.rejects(f.service.receiveWebhook(f.signedEvent({ id: "evt_localfixture",
      object: f.intent({ description: "different signed payload" }) })), /WEBHOOK_EVENT_CONFLICT/);
    const run = await f.service.read(f.runId, f.token);
    assert.equal(run.state, "succeeded");
    assert.equal(run.payment.paymentStatus, "succeeded");
    assert.equal(run.webhookReceipts.length, 1);
    assert.equal(run.events.filter((item) => item.type === "stripe.webhook_confirmed").length, 1);
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("a webhook arriving before the Stripe response cannot be overwritten by finalization", async () => {
  let releasePay;
  let payStarted;
  const started = new Promise((resolve) => { payStarted = resolve; });
  const f = await fixture({ deferPayment: true, payImpl: async ({ attemptPath, runId }) => {
    await writeFile(attemptPath, JSON.stringify({ runId, amountMinor: 30319,
      currency: "usd", quoteHash: f.quoteHash, paymentIntentId: paymentId }), { mode: 0o600 });
    payStarted();
    await new Promise((resolve) => { releasePay = resolve; });
    throw new Error("response lost after webhook");
  } });
  try {
    const payment = f.service.pay(f.runId, f.token, f.env.STRIPE_SECRET_KEY);
    await started;
    assert.deepEqual(await f.service.receiveWebhook(f.signedEvent()), { disposition: "recorded" });
    releasePay();
    const result = await payment;
    assert.equal(result.state, "succeeded");
    assert.equal(result.webhookReceipts.length, 1);
    assert.equal((await f.service.read(f.runId, f.token)).state, "succeeded");
  } finally { releasePay?.(); await f.cleanup(); }
});

test("a pending HTTP response cannot replace a webhook-confirmed payment", async () => {
  let releasePay;
  let payStarted;
  const started = new Promise((resolve) => { payStarted = resolve; });
  const f = await fixture({ deferPayment: true, payImpl: async ({ attemptPath, runId }) => {
    await writeFile(attemptPath, JSON.stringify({ runId, amountMinor: 30319,
      currency: "usd", quoteHash: f.quoteHash, paymentIntentId: paymentId }), { mode: 0o600 });
    payStarted();
    await new Promise((resolve) => { releasePay = resolve; });
    return { paymentStatus: "processing", paymentIntentSuffix: paymentId.slice(-8) };
  } });
  try {
    const payment = f.service.pay(f.runId, f.token, f.env.STRIPE_SECRET_KEY);
    await started;
    assert.deepEqual(await f.service.receiveWebhook(f.signedEvent()), { disposition: "recorded" });
    releasePay();
    const result = await payment;
    assert.equal(result.state, "succeeded");
    assert.equal(result.payment.paymentStatus, "succeeded");
    assert.equal((await f.service.read(f.runId, f.token)).payment.paymentStatus, "succeeded");
  } finally { releasePay?.(); await f.cleanup(); }
});

test("invalid signature, live mode, and mismatched evidence cannot alter a run", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.receiveWebhook({ ...f.signedEvent(), signature: "bad" }),
      /WEBHOOK_SIGNATURE_INVALID/);
    await assert.rejects(f.service.receiveWebhook(f.signedEvent({ livemode: true })), /LIVE_WEBHOOK_DENIED/);
    await assert.rejects(f.service.receiveWebhook(f.signedEvent({ object: f.intent({ amount: 100 }) })),
      /WEBHOOK_EVIDENCE_MISMATCH/);
    await assert.rejects(f.service.receiveWebhook(f.signedEvent({ object: f.intent({ status: "processing" }) })),
      /WEBHOOK_EVIDENCE_MISMATCH/);
    assert.deepEqual(await f.service.receiveWebhook(f.signedEvent({ object: f.intent({ metadata: {} }) })),
      { disposition: "ignored_foreign" });
    assert.equal((await f.service.read(f.runId, f.token)).state, "payment_uncertain");
    assert.equal((await f.service.read(f.runId, f.token)).webhookReceipts.length, 0);
  } finally { await f.cleanup(); }
});

test("read-only retrieval resolves a known PaymentIntent without any Stripe mutation", async () => {
  const f = await fixture();
  try {
    const run = await f.service.reconcile(f.runId, f.token, f.env.STRIPE_SECRET_KEY);
    assert.equal(run.state, "succeeded");
    assert.equal(run.reconciliation.outcome, "matched");
    assert.deepEqual(f.calls.map((call) => call.path), ["/v1/account", `/v1/payment_intents/${paymentId}`]);
    assert.ok(f.calls.every((call) => call.method === "GET"));
  } finally { await f.cleanup(); }
});

test("absence in a recent read-only list remains uncertain and never authorizes a retry", async () => {
  const f = await fixture({ knownPaymentId: false });
  try {
    const run = await f.service.reconcile(f.runId, f.token, f.env.STRIPE_SECRET_KEY);
    assert.equal(run.state, "payment_uncertain");
    assert.equal(run.reconciliation.outcome, "unresolved");
    assert.ok(f.calls.every((call) => call.method === "GET"));
    await assert.rejects(f.service.pay(f.runId, f.token, f.env.STRIPE_SECRET_KEY),
      /PAYMENT_ALREADY_RESERVED_OR_NOT_APPROVED/);
  } finally { await f.cleanup(); }
});

test("multiple provider candidates stay ambiguous and a wrong account fails closed", async () => {
  const ambiguous = await fixture({ knownPaymentId: false,
    list: [{ id: "pi_candidateA" }, { id: "pi_candidateB" }] });
  try {
    const run = await ambiguous.service.reconcile(ambiguous.runId, ambiguous.token, ambiguous.env.STRIPE_SECRET_KEY);
    assert.equal(run.state, "payment_uncertain");
    assert.equal(run.reconciliation.outcome, "ambiguous");
  } finally { await ambiguous.cleanup(); }
  const wrong = await fixture({ accountId: "acct_wrong" });
  try {
    await assert.rejects(wrong.service.reconcile(wrong.runId, wrong.token, wrong.env.STRIPE_SECRET_KEY),
      /SANDBOX_ACCOUNT_MISMATCH/);
    assert.equal((await wrong.service.read(wrong.runId, wrong.token)).state, "payment_uncertain");
    assert.deepEqual(wrong.calls.map((call) => call.path), ["/v1/account"]);
  } finally { await wrong.cleanup(); }
});

test("webhook HTTP route requires local flag and endpoint secret", async () => {
  const f = await fixture();
  try {
    const signed = f.signedEvent();
    const request = (body = signed.rawBody) => new Request("http://localhost:3000/api/local-demo/stripe-webhook",
      { method: "POST", headers: { host: "127.0.0.1:3000", "stripe-signature": signed.signature }, body });
    const disabled = createLocalJourneyHandlers({ env: { ...f.env, PAYMENTLAB_LOCAL_WEBHOOK_ENABLE: "0" }, service: f.service });
    assert.equal((await disabled.webhook(request())).status, 503);
    const enabled = createLocalJourneyHandlers({ env: f.env, service: f.service });
    assert.equal((await enabled.webhook(request())).status, 200);
    assert.equal((await enabled.webhook(request())).status, 200);
    const remote = new Request("https://example.com/api/local-demo/stripe-webhook",
      { method: "POST", headers: { host: "example.com", "stripe-signature": signed.signature }, body: signed.rawBody });
    assert.equal((await enabled.webhook(remote)).status, 503);
  } finally { await f.cleanup(); }
});
