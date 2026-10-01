# Optional Stripe sandbox payment

This step is separate from the scripted Studio and local A2A quote. The local Buyer and Merchant negotiate a fictional purchase through open A2A. **Only after a human approves the exact quote and presses a separate payment button** can the server try a Stripe test-mode payment. The Stripe Shared Payment Token is produced by Stripe's **seller-side test helper**, which simulates Buyer issuance. This is a protocol demonstration, not Buyer-issued token interoperability or a production checkout.

## Prerequisites

- A Stripe sandbox/test account in the **US** with access to the Shared Payment Token seller test helper. The demo currently checks `country=US`; if your sandbox is elsewhere, you can still run all non-Stripe modes.
- The sandbox's `sk_test_...` secret key and `acct_...` account ID. Find API keys in the Stripe Dashboard **Developers → API keys** while the intended sandbox is selected. Check your account details for the account ID. Never use a live key.
- The LM Studio and `/local-sandbox` setup in [LOCAL-MODEL.md](LOCAL-MODEL.md).
- Optional: Stripe CLI for signed webhook forwarding.

## Configure

In the ignored `.env.local`:

```dotenv
PAYMENTLAB_ENVIRONMENT=local
PAYMENTLAB_LOCAL_DEMO_ENABLE=1
PAYMENTLAB_LOCAL_STRIPE_PAYMENT_ENABLE=1
PAYMENTLAB_STRIPE_ACCOUNT_ID=acct_YOUR_OWN_SANDBOX_ACCOUNT_ID
STRIPE_SECRET_KEY=sk_test_YOUR_OWN_SANDBOX_KEY
```

Keep either the file-backed state settings from the local-model guide or the PostgreSQL settings from [POSTGRES.md](POSTGRES.md). Restart `npm run dev` after changing `.env.local`. The server verifies the key is test-mode and fetches `/v1/account` to match the configured account ID and US country before reserving an attempt. Do not paste keys into issues, chat, screenshots, or Git commits.

For webhook evidence, install and authenticate the Stripe CLI for **this same sandbox**, then in a second terminal:

```sh
stripe listen --forward-to 127.0.0.1:3000/api/local-demo/stripe-webhook
```

The listener prints a `whsec_...` signing secret. Put **that listener's** secret in `.env.local` as `STRIPE_WEBHOOK_SECRET`, set `PAYMENTLAB_LOCAL_WEBHOOK_ENABLE=1`, and restart Next.js. The dashboard endpoint signing secret is different; do not substitute it for the CLI listener secret. Keep the listener running during the run.

## Run one test payment

1. Open `http://127.0.0.1:3000/local-sandbox`, start a **fresh** run, and inspect the A2A quote.
2. Approve the exact total shown. The amount is computed by the server from the demo catalog, not chosen by the model.
3. Press the separate Stripe sandbox payment button **once**. It creates a bounded seller-side SPT test helper token, sends one idempotent PaymentIntent request, and retrieves the result.
4. Inspect the safe status and evidence timeline. If you enabled the listener, a verified webhook receipt can also appear. A missing webhook receipt does not mean the retrieved PaymentIntent failed.
5. If the result is uncertain, use the UI's read-only reconcile action. Do not start another payment for the same run. Inspect the Stripe Dashboard sandbox Transactions view for the matching test PaymentIntent.

The helper uses a Visa test payment method and `2026-04-22.preview` API version. Stripe's feature availability and API behavior may change; if the helper returns a feature/access error, leave payment disabled and use the model/A2A simulation. No real card number or funds are needed.

[Stripe sandbox guide](https://docs.stripe.com/sandboxes) · [API keys](https://docs.stripe.com/keys) · [Shared Payment Tokens and seller test helper](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens?agent-seller=seller) · [Local webhook forwarding](https://docs.stripe.com/webhooks?lang=node#test-locally)
