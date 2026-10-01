import { randomUUID, createHash } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { quoteDemoProduct } from "../a2a/merchant.mjs";

const STRIPE_VERSION = "2026-04-22.preview";
const STRIPE_URL = "https://api.stripe.com";

export class SandboxPaymentError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function assertInputs({ apiKey, accountId, receipt, approval, attemptPath, attemptStore }) {
  if (typeof apiKey !== "string" || !apiKey.startsWith("sk_test_")) throw new SandboxPaymentError("TEST_KEY_REQUIRED");
  if (!/^acct_[A-Za-z0-9]{8,}$/.test(accountId ?? "")) throw new SandboxPaymentError("STRIPE_ACCOUNT_ID_REQUIRED");
  const fileStore = typeof attemptPath === "string" && isAbsolute(attemptPath);
  const durableStore = typeof attemptStore?.create === "function" && typeof attemptStore?.update === "function";
  if (!fileStore && !durableStore) throw new SandboxPaymentError("ATTEMPT_PATH_REQUIRED");
  if (fileStore && durableStore) throw new SandboxPaymentError("EXACTLY_ONE_ATTEMPT_STORE_REQUIRED");
  const productId = receipt?.quote?.productId;
  const quote = quoteDemoProduct({ productId, quantity: 1 });
  if (quote.outcome !== "quoted" || receipt.quote.currency !== "usd"
    || receipt.quote.totalMinor !== quote.totalMinor
    || (receipt.quote.catalogVersion && receipt.quote.catalogVersion !== quote.catalogVersion)) {
    throw new SandboxPaymentError("CATALOG_QUOTE_CHANGED");
  }
  if (approval !== `usd:${quote.totalMinor}:${productId}`) throw new SandboxPaymentError("EXACT_APPROVAL_REQUIRED");
  if (receipt?.provider !== "lmstudio" || receipt?.protocol !== "A2A 1.0 JSON-RPC"
    || receipt?.taskState !== "TASK_STATE_COMPLETED" || receipt?.buyer?.selectedProductId !== productId
    || receipt.paymentCalls !== 0) {
    throw new SandboxPaymentError("A2A_RECEIPT_INVALID");
  }
  return quote;
}

async function createAttempt(path, record) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") throw new SandboxPaymentError("ATTEMPT_ALREADY_EXISTS");
    throw error;
  } finally { await handle?.close(); }
}

async function updateAttempt(path, record) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

function safeRequestId(response) {
  const id = response.headers?.get?.("request-id");
  return /^req_[A-Za-z0-9]{1,80}$/.test(id ?? "") ? id : null;
}

async function stripeRequest(fetchImpl, apiKey, path, { method = "GET", form, idempotencyKey } = {}) {
  let response;
  try {
    response = await fetchImpl(`${STRIPE_URL}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        "Stripe-Version": STRIPE_VERSION,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(form ? { body: form.toString() } : {}),
    });
  } catch { throw new SandboxPaymentError("STRIPE_RESPONSE_UNCERTAIN"); }
  let body;
  try { body = await response.json(); }
  catch { throw new SandboxPaymentError("STRIPE_RESPONSE_UNCERTAIN"); }
  if (!response.ok) {
    const code = body?.error?.code;
    throw new SandboxPaymentError(/^[-a-z0-9_]{1,80}$/.test(code ?? "")
      ? `STRIPE_HTTP_${response.status}_${code}` : `STRIPE_HTTP_${response.status}`);
  }
  return { body, requestId: safeRequestId(response) };
}

export async function runOneSandboxSPTPayment({ apiKey, accountId, receipt, approval, attemptPath, attemptStore,
  runId = randomUUID(), fetchImpl = fetch, now = () => Date.now() } = {}) {
  const quote = assertInputs({ apiKey, accountId, receipt, approval, attemptPath, attemptStore });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) {
    throw new SandboxPaymentError("RUN_ID_INVALID");
  }
  const account = await stripeRequest(fetchImpl, apiKey, "/v1/account");
  if (account.body?.id !== accountId || account.body?.country !== "US") {
    throw new SandboxPaymentError("SANDBOX_ACCOUNT_MISMATCH");
  }
  const quoteHash = createHash("sha256").update(JSON.stringify(receipt.quote)).digest("hex");
  const record = { version: 1, runId, accountId, amountMinor: quote.totalMinor,
    currency: "usd", productId: quote.productId, quoteHash,
    helperIdempotencyKey: `paymentlab-helper-${runId}`,
    paymentIdempotencyKey: `paymentlab-payment-${runId}`, state: "reserved" };
  if (attemptStore) await attemptStore.create(record);
  else await createAttempt(attemptPath, record);
  const saveAttempt = attemptStore ? (value) => attemptStore.update(value)
    : (value) => updateAttempt(attemptPath, value);
  const expiresAt = Math.floor(now() / 1000) + 600;
  const helperForm = new URLSearchParams({ payment_method: "pm_card_visa",
    "usage_limits[currency]": "usd", "usage_limits[max_amount]": String(quote.totalMinor),
    "usage_limits[expires_at]": String(expiresAt) });
  record.state = "helper_dispatching";
  await saveAttempt(record);
  let helper;
  try {
    helper = await stripeRequest(fetchImpl, apiKey, "/v1/test_helpers/shared_payment/granted_tokens",
      { method: "POST", form: helperForm, idempotencyKey: record.helperIdempotencyKey });
  } catch (error) {
    record.state = "helper_uncertain_or_rejected";
    await saveAttempt(record);
    throw error;
  }
  const spt = helper.body;
  if (spt?.object !== "shared_payment.granted_token" || !/^spt_[A-Za-z0-9]+$/.test(spt?.id ?? "")
    || spt.livemode !== false || spt.usage_limits?.currency !== "usd"
    || spt.usage_limits?.max_amount !== quote.totalMinor || spt.usage_limits?.expires_at !== expiresAt) {
    record.state = "helper_response_invalid";
    await saveAttempt(record);
    throw new SandboxPaymentError("SPT_SCOPE_INVALID");
  }
  record.state = "helper_confirmed";
  record.helperRequestId = helper.requestId;
  await saveAttempt(record);
  const paymentForm = new URLSearchParams({ amount: String(quote.totalMinor), currency: "usd",
    "payment_method_data[shared_payment_granted_token]": spt.id,
    confirm: "true", capture_method: "automatic",
    "metadata[paymentlab_demo]": "local_a2a_spt_helper",
    "metadata[paymentlab_product_id]": quote.productId,
    "metadata[paymentlab_run_id]": runId,
    "metadata[paymentlab_quote_hash]": quoteHash });
  record.state = "payment_dispatching";
  await saveAttempt(record);
  let payment;
  try {
    payment = await stripeRequest(fetchImpl, apiKey, "/v1/payment_intents",
      { method: "POST", form: paymentForm, idempotencyKey: record.paymentIdempotencyKey });
  } catch (error) {
    record.state = "payment_uncertain_or_rejected";
    await saveAttempt(record);
    throw error;
  }
  const intent = payment.body;
  if (intent?.object !== "payment_intent" || !/^pi_[A-Za-z0-9]+$/.test(intent?.id ?? "")
    || intent.livemode !== false || intent.amount !== quote.totalMinor || intent.currency !== "usd") {
    record.state = "payment_response_invalid";
    await saveAttempt(record);
    throw new SandboxPaymentError("PAYMENT_RESPONSE_INVALID");
  }
  record.paymentIntentId = intent.id;
  record.paymentRequestId = payment.requestId;
  record.state = "payment_retrieving";
  await saveAttempt(record);
  let retrieved;
  try {
    retrieved = await stripeRequest(fetchImpl, apiKey, `/v1/payment_intents/${intent.id}`);
  } catch (error) {
    record.state = "payment_retrieval_uncertain";
    await saveAttempt(record);
    throw error;
  }
  const verified = retrieved.body;
  if (verified?.id !== intent.id || verified.object !== "payment_intent"
    || verified.livemode !== false || verified.amount !== quote.totalMinor || verified.currency !== "usd"
    || typeof verified.status !== "string"
    || verified.metadata?.paymentlab_run_id !== runId
    || verified.metadata?.paymentlab_quote_hash !== quoteHash
    || (verified.status === "succeeded" && (verified.amount_received !== quote.totalMinor
      || !/^pm_[A-Za-z0-9]+$/.test(verified.payment_method ?? "")))) {
    record.state = "payment_retrieval_invalid";
    await saveAttempt(record);
    throw new SandboxPaymentError("PAYMENT_RETRIEVAL_INVALID");
  }
  record.state = verified.status === "succeeded" ? "provider_confirmed_succeeded" : `provider_${verified.status}`;
  record.retrievalRequestId = retrieved.requestId;
  await saveAttempt(record);
  return { accountId, livemode: false, amountMinor: quote.totalMinor, currency: "usd",
    sptIssuance: "seller_test_helper_simulated", paymentStatus: verified.status,
    paymentIntentSuffix: intent.id.slice(-8), helperRequestId: helper.requestId,
    paymentRequestId: payment.requestId, retrievalRequestId: retrieved.requestId,
    paymentCalls: 1 };
}

export async function readSandboxAttempt(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
