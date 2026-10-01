import { createStripeWebhookPost } from "../../../../lib/payments/stripe-webhook-route.mjs";
import { createLocalEffectGuardFromEnv } from "../../../../lib/sandbox/effect-guard.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The integration owner must compose the data-owned persistence adapter. Until
// that happens the exported route is deliberately unavailable rather than
// acknowledging an event without a durable receipt.
const webhookPost = createStripeWebhookPost({
  receiptService: null,
  endpointSecret: () => process.env.STRIPE_WEBHOOK_SECRET,
});
const effectGuard = createLocalEffectGuardFromEnv();

export async function POST(request) {
  try {
    effectGuard.assertAllowed("stripe-webhook");
  } catch (error) {
    if (error?.code === "EFFECT_GUARD_DENIED" || error?.code === "EFFECT_OBSERVER_REQUIRED") {
      return Response.json({ error: "Webhook effect capability is denied." }, { status: 503 });
    }
    throw error;
  }
  return webhookPost(request);
}
