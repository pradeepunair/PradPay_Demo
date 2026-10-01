import { WebhookRejectedError } from "./stripe-webhook-receipts.mjs";

const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

function json(body, status) {
  return Response.json(body, { status, headers: responseHeaders });
}

export function createStripeWebhookPost({ receiptService, endpointSecret }) {
  return async function stripeWebhookPost(request) {
    if (!receiptService || typeof receiptService.receive !== "function") {
      return json({ error: "Webhook receipt persistence is unavailable." }, 503);
    }
    const secret = typeof endpointSecret === "function" ? endpointSecret() : endpointSecret;
    if (!secret) return json({ error: "Webhook endpoint is not configured." }, 503);

    const signature = request.headers.get("stripe-signature");
    if (!signature) return json({ error: "Webhook signature is required." }, 400);

    const rawBody = Buffer.from(await request.arrayBuffer());
    try {
      const result = await receiptService.receive({ rawBody, signature, endpointSecret: secret });
      return json({ received: true, disposition: result.disposition }, 200);
    } catch (error) {
      if (error instanceof WebhookRejectedError) {
        const message = error.code === "rejected_live_mode"
          ? "Live-mode Stripe events are not accepted."
          : "Webhook signature verification failed.";
        return json({ error: message }, 400);
      }
      return json({ error: "Webhook receipt could not be durably recorded." }, 503);
    }
  };
}
