import { createHash } from "node:crypto";

const VERSION = "2026-04-22.preview";
const statuses = new Set(["succeeded", "processing", "requires_action", "requires_payment_method",
  "requires_confirmation", "requires_capture", "canceled"]);

export class StripeReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function get(path, apiKey, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`https://api.stripe.com${path}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        "Stripe-Version": VERSION,
      },
    });
  } catch { throw new StripeReadError("STRIPE_READ_UNAVAILABLE"); }
  if (!response.ok) throw new StripeReadError(`STRIPE_READ_HTTP_${response.status}`);
  try { return await response.json(); }
  catch { throw new StripeReadError("STRIPE_READ_INVALID"); }
}

export function matchPaymentIntent(intent, { runId, quote, quoteHash }) {
  if (!quote || !Number.isSafeInteger(quote.totalMinor) || quote.totalMinor < 1
    || typeof quote.productId !== "string"
    || intent?.object !== "payment_intent" || !/^pi_[A-Za-z0-9]+$/.test(intent?.id ?? "")
    || intent.livemode !== false || intent.amount !== quote?.totalMinor || intent.currency !== "usd"
    || intent.metadata?.paymentlab_demo !== "local_a2a_spt_helper"
    || intent.metadata?.paymentlab_run_id !== runId
    || intent.metadata?.paymentlab_quote_hash !== quoteHash
    || intent.metadata?.paymentlab_product_id !== quote.productId
    || !statuses.has(intent.status)) return false;
  if (intent.status === "succeeded" && (intent.amount_received !== quote.totalMinor
    || !/^pm_[A-Za-z0-9]+$/.test(intent.payment_method ?? ""))) return false;
  return true;
}

export function safePaymentIntent(intent, accountId) {
  return { accountId, livemode: false, amountMinor: intent.amount,
    currency: "usd", sptIssuance: "seller_test_helper_simulated",
    paymentStatus: intent.status, paymentIntentSuffix: intent.id.slice(-8),
    paymentCalls: 1 };
}

export async function reconcileStripeIntent({ apiKey, accountId, runId, quote, attempt,
  fetchImpl = fetch } = {}) {
  if (typeof apiKey !== "string" || !apiKey.startsWith("sk_test_")) {
    throw new StripeReadError("TEST_KEY_REQUIRED");
  }
  if (!/^acct_[A-Za-z0-9]{8,}$/.test(accountId ?? "")) throw new StripeReadError("STRIPE_ACCOUNT_ID_REQUIRED");
  if (!attempt || attempt.runId !== runId || attempt.amountMinor !== quote?.totalMinor
    || attempt.currency !== "usd" || !/^[a-f0-9]{64}$/.test(attempt.quoteHash ?? "")
    || attempt.quoteHash !== createHash("sha256").update(JSON.stringify(quote)).digest("hex")) {
    throw new StripeReadError("ATTEMPT_MISMATCH");
  }
  const account = await get("/v1/account", apiKey, fetchImpl);
  if (account?.id !== accountId || account?.country !== "US") {
    throw new StripeReadError("SANDBOX_ACCOUNT_MISMATCH");
  }
  let matches;
  if (attempt.paymentIntentId) {
    if (!/^pi_[A-Za-z0-9]+$/.test(attempt.paymentIntentId)) throw new StripeReadError("ATTEMPT_MISMATCH");
    const intent = await get(`/v1/payment_intents/${attempt.paymentIntentId}`, apiKey, fetchImpl);
    matches = [intent];
  } else {
    const list = await get("/v1/payment_intents?limit=100", apiKey, fetchImpl);
    if (!Array.isArray(list?.data)) throw new StripeReadError("STRIPE_READ_INVALID");
    matches = list.data.filter((intent) => intent?.metadata?.paymentlab_run_id === runId);
    if (matches.length === 0) return { outcome: "unresolved" }; // A recent list cannot prove absence.
    if (matches.length > 1) return { outcome: "ambiguous" };
  }
  const intent = matches[0];
  if (!matchPaymentIntent(intent, { runId, quote, quoteHash: attempt.quoteHash })
    || (attempt.paymentIntentId && intent.id !== attempt.paymentIntentId)) {
    throw new StripeReadError("PROVIDER_EVIDENCE_MISMATCH");
  }
  return { outcome: "matched", payment: safePaymentIntent(intent, accountId), paymentIntentId: intent.id };
}
