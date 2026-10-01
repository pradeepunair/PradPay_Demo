import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { quoteDemoProduct } from "../lib/a2a/merchant.mjs";
import { readSandboxAttempt, runOneSandboxSPTPayment } from "../lib/sandbox/stripe-spt-payment.mjs";

const receipt = { provider: "lmstudio", protocol: "A2A 1.0 JSON-RPC",
  taskState: "TASK_STATE_COMPLETED", buyer: { selectedProductId: "aurora-pro" },
  quote: { productId: "aurora-pro", currency: "usd", totalMinor: 30319 }, paymentCalls: 0 };

function response(body, requestId = "req_test") {
  return new Response(JSON.stringify(body), { status: 200, headers: { "request-id": requestId } });
}

function fakeStripe({ failPayment = false, badScope = false, amountMinor = 30319 } = {}) {
  const seen = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    const form = options.body ? new URLSearchParams(options.body) : null;
    seen.push({ path, method: options.method, form, headers: options.headers });
    if (path === "/v1/account") return response({ id: "acct_demofixture0001", country: "US" });
    if (path === "/v1/test_helpers/shared_payment/granted_tokens") {
      return response({ id: "spt_testfixture", object: "shared_payment.granted_token", livemode: false,
        usage_limits: { currency: "usd", max_amount: badScope ? 999 : amountMinor,
          expires_at: Number(form.get("usage_limits[expires_at]")) } });
    }
    if (path === "/v1/payment_intents") {
      if (failPayment) throw new Error("simulated lost response");
      return response({ id: "pi_testfixture", object: "payment_intent", livemode: false,
        amount: amountMinor, currency: "usd", status: "succeeded" });
    }
    if (path === "/v1/payment_intents/pi_testfixture") return response({
      id: "pi_testfixture", object: "payment_intent", livemode: false,
      amount: amountMinor, amount_received: amountMinor, currency: "usd", status: "succeeded",
      payment_method: "pm_clonedfixture",
      metadata: { paymentlab_run_id: seen[2].form.get("metadata[paymentlab_run_id]"),
        paymentlab_quote_hash: seen[2].form.get("metadata[paymentlab_quote_hash]") },
    });
    throw new Error("unexpected endpoint");
  };
  return { seen, fetchImpl };
}

test("one exact approved SPT sandbox payment is provider-retrieved and cannot be rerun", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paymentlab-spt-"));
  const attemptPath = join(dir, "attempt.json");
  const stripe = fakeStripe();
  try {
    const result = await runOneSandboxSPTPayment({ apiKey: "sk_test_fixture", accountId: "acct_demofixture0001", receipt,
      approval: "usd:30319:aurora-pro", attemptPath, fetchImpl: stripe.fetchImpl,
      now: () => 1_800_000_000_000 });
    assert.equal(result.paymentStatus, "succeeded");
    assert.equal(result.sptIssuance, "seller_test_helper_simulated");
    assert.equal(result.paymentCalls, 1);
    assert.deepEqual(stripe.seen.map((entry) => entry.path), ["/v1/account",
      "/v1/test_helpers/shared_payment/granted_tokens", "/v1/payment_intents",
      "/v1/payment_intents/pi_testfixture"]);
    assert.equal(stripe.seen[1].form.get("usage_limits[max_amount]"), "30319");
    assert.equal(stripe.seen[2].form.get("amount"), "30319");
    assert.equal(stripe.seen[2].form.get("payment_method_data[shared_payment_granted_token]"), "spt_testfixture");
    assert.equal(stripe.seen[2].headers["Stripe-Version"], "2026-04-22.preview");
    assert.match(stripe.seen[2].headers["Idempotency-Key"], /^paymentlab-payment-/);
    assert.equal((await readSandboxAttempt(attemptPath)).state, "provider_confirmed_succeeded");
    await assert.rejects(runOneSandboxSPTPayment({ apiKey: "sk_test_fixture", accountId: "acct_demofixture0001", receipt,
      approval: "usd:30319:aurora-pro", attemptPath, fetchImpl: stripe.fetchImpl }), /ATTEMPT_ALREADY_EXISTS/);
    assert.equal(stripe.seen.filter((entry) => entry.path === "/v1/payment_intents").length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("catalog-priced non-Aurora quote scopes the helper and PaymentIntent to its exact amount", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paymentlab-spt-other-"));
  const quote = quoteDemoProduct({ productId: "metro-lite", quantity: 1 });
  const other = { ...receipt, buyer: { selectedProductId: "metro-lite" }, quote };
  const stripe = fakeStripe({ amountMinor: quote.totalMinor });
  try {
    const result = await runOneSandboxSPTPayment({ apiKey: "sk_test_fixture", accountId: "acct_demofixture0001", receipt: other,
      approval: `usd:${quote.totalMinor}:metro-lite`, attemptPath: join(dir, "attempt.json"),
      fetchImpl: stripe.fetchImpl });
    assert.equal(result.amountMinor, quote.totalMinor);
    assert.equal(stripe.seen[1].form.get("usage_limits[max_amount]"), String(quote.totalMinor));
    assert.equal(stripe.seen[2].form.get("amount"), String(quote.totalMinor));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("wrong approval or account never reaches a Stripe mutation", async () => {
  const stripe = fakeStripe();
  await assert.rejects(runOneSandboxSPTPayment({ apiKey: "sk_test_fixture", receipt,
    approval: "usd:30319:aurora-pro", attemptPath: "/tmp/unused-attempt.json",
    fetchImpl: stripe.fetchImpl }), /STRIPE_ACCOUNT_ID_REQUIRED/);
  assert.equal(stripe.seen.length, 0);
  await assert.rejects(runOneSandboxSPTPayment({ apiKey: "sk_test_fixture", accountId: "acct_demofixture0001", receipt,
    approval: "usd:100:aurora-pro", attemptPath: "/tmp/unused-attempt.json",
    fetchImpl: stripe.fetchImpl }), /EXACT_APPROVAL_REQUIRED/);
  assert.equal(stripe.seen.length, 0);
  const wrongAccount = async () => response({ id: "acct_other", country: "US" });
  await assert.rejects(runOneSandboxSPTPayment({ apiKey: "sk_test_fixture", accountId: "acct_demofixture0001", receipt,
    approval: "usd:30319:aurora-pro", attemptPath: "/tmp/unused-attempt.json",
    fetchImpl: wrongAccount }), /SANDBOX_ACCOUNT_MISMATCH/);
});

test("invalid SPT scope and uncertain payment response stop without retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paymentlab-spt-"));
  try {
    const badScope = fakeStripe({ badScope: true });
    await assert.rejects(runOneSandboxSPTPayment({ apiKey: "sk_test_fixture", accountId: "acct_demofixture0001", receipt,
      approval: "usd:30319:aurora-pro", attemptPath: join(dir, "bad-scope.json"),
      fetchImpl: badScope.fetchImpl }), /SPT_SCOPE_INVALID/);
    assert.equal(badScope.seen.some((entry) => entry.path === "/v1/payment_intents"), false);
    const uncertain = fakeStripe({ failPayment: true });
    const attemptPath = join(dir, "uncertain.json");
    await assert.rejects(runOneSandboxSPTPayment({ apiKey: "sk_test_fixture", accountId: "acct_demofixture0001", receipt,
      approval: "usd:30319:aurora-pro", attemptPath, fetchImpl: uncertain.fetchImpl }),
    /STRIPE_RESPONSE_UNCERTAIN/);
    assert.equal((await readSandboxAttempt(attemptPath)).state, "payment_uncertain_or_rejected");
    assert.equal(uncertain.seen.filter((entry) => entry.path === "/v1/payment_intents").length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the SPT helper journals each transition through a durable attempt store", async () => {
  const stripe = fakeStripe();
  const states = [];
  let created = false;
  const attemptStore = {
    async create(record) {
      if (created) throw new Error("ATTEMPT_ALREADY_EXISTS");
      created = true;
      states.push(record.state);
    },
    async update(record) { states.push(record.state); },
  };
  const result = await runOneSandboxSPTPayment({ apiKey: "sk_test_fixture", accountId: "acct_demofixture0001", receipt,
    approval: "usd:30319:aurora-pro", attemptStore, fetchImpl: stripe.fetchImpl });
  assert.equal(result.paymentStatus, "succeeded");
  assert.deepEqual(states, ["reserved", "helper_dispatching", "helper_confirmed",
    "payment_dispatching", "payment_retrieving", "provider_confirmed_succeeded"]);
  await assert.rejects(runOneSandboxSPTPayment({ apiKey: "sk_test_fixture", accountId: "acct_demofixture0001", receipt,
    approval: "usd:30319:aurora-pro", attemptStore, fetchImpl: stripe.fetchImpl }), /ATTEMPT_ALREADY_EXISTS/);
  assert.equal(stripe.seen.filter((entry) => entry.path === "/v1/payment_intents").length, 1);
});
