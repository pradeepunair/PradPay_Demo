import Stripe from "stripe";

const webhookVerifier = Stripe.webhooks;

export const supportedStripeEventTypes = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.canceled",
  "shared_payment.granted_token.used",
  "shared_payment.granted_token.deactivated",
]);

export function verifyStripeEvent({
  rawBody,
  signature,
  endpointSecret,
  toleranceSeconds = 300,
  receivedAt,
}) {
  if (!endpointSecret) throw new Error("Webhook signing secret is unavailable.");
  if (!signature) throw new Error("Stripe signature is unavailable.");
  if (!(typeof rawBody === "string" || ArrayBuffer.isView(rawBody))) {
    throw new TypeError("Webhook body must be untouched text or bytes.");
  }

  return webhookVerifier.constructEvent(
    rawBody,
    signature,
    endpointSecret,
    toleranceSeconds,
    undefined,
    receivedAt,
  );
}

export function classifyStripeEvent(event) {
  if (event.livemode !== false) {
    return { accepted: false, disposition: "rejected_live_mode" };
  }

  if (!supportedStripeEventTypes.has(event.type)) {
    return { accepted: true, disposition: "ignored" };
  }

  return { accepted: true, disposition: "received" };
}
