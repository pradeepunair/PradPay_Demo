# AI agent setup guide

This file is for an AI agent asked to set up or run **PradPay Demo** from a fresh clone. Start with the scripted simulation. Treat LM Studio, PostgreSQL, and Stripe as separate, opt-in integrations. The [human README](README.md) and the linked guides are the source of truth for the current package.

## 1. Inspect before changing anything

1. Confirm you are in the `PradPay_Demo` repository and inspect `git status --short --branch`. Preserve any existing user changes.
2. Read `README.md`, `.env.example`, and `package.json`. For an optional path, read its dedicated guide before configuring it: [local model](docs/LOCAL-MODEL.md), [PostgreSQL](docs/POSTGRES.md), or [Stripe sandbox](docs/STRIPE-SANDBOX.md).
3. Check that Node.js 22 and npm are available. If you will **change Next.js code**, consult the relevant guide in this installed version's `node_modules/next/dist/docs/` first; do not assume older Next.js APIs apply.

## 2. Bring up the key-free simulation

From the repository root:

```sh
npm ci
```

If `.env.local` does not exist, copy `.env.example` to `.env.local`. Keep `PAYMENTLAB_WORKFLOW_BUILD_MODE=protected-deny`. Do not overwrite a user's existing `.env.local`, print its contents, or commit it. Then run:

```sh
npm run demo:test
npm run build
npm run dev
```

Open `http://127.0.0.1:3000/simulation`. Confirm that the page loads, a teaching scenario can be selected, exchanges advance, and the shared evidence trail updates. This mode uses scripted fixtures; it requires no model, database, Stripe account, or payment approval. `npm run demo:test` uses local fixtures and must not contact paid providers.

If port 3000 is already occupied, identify the process before changing or stopping it. You may launch this app on another loopback port with `npx next dev --hostname 127.0.0.1 --port PORT`; report the actual URL to the user.

## 3. Add an optional local model only when requested

Follow [docs/LOCAL-MODEL.md](docs/LOCAL-MODEL.md). Ask the user to start LM Studio and load a model if it is not already running. Verify the local API through `http://127.0.0.1:1234/v1/models`, select the exact returned model ID, and set the documented variables in ignored `.env.local`. Restart Next.js after changing environment variables. The server validates catalog and quote constraints; do not treat model output as payment authority.

For the separate `/local-sandbox` A2A journey, create an owner-only local state directory **outside the repository**, enable the local demo flags, and start a fresh run. This path uses the open A2A JSON-RPC exchange between Buyer and Merchant. A local-model suggestion inside `/simulation` alone does not turn the scripted Studio into a live A2A run.

## 4. Add persistence or Stripe only when requested

- **Local PostgreSQL:** Follow [docs/POSTGRES.md](docs/POSTGRES.md). Use a disposable loopback database, apply the foundation migration before the mode-specific migrations, and enable only the requested mode. The Studio's durable payment remains simulated.
- **Stripe sandbox:** Follow [docs/STRIPE-SANDBOX.md](docs/STRIPE-SANDBOX.md). Require the user's own US test sandbox, `acct_...` account ID, and `sk_test_...` key in ignored `.env.local`; never use live keys. Verify that the sandbox account matches before any attempt. A signed local webhook requires its own `whsec_...` secret and a running listener.

Do not create or confirm a Stripe PaymentIntent merely to verify setup. First establish the exact quote, let the human review it, and obtain authorization for that specific **test** payment. The separate UI button is the intended dispatch point. The seller-side SPT test helper simulates Buyer token issuance; do not describe it as a Buyer-issued token. If a response is uncertain, use read-only reconciliation and do not retry payment for the same run.

## 5. Verify and report

Report which mode you ran, the local URL, the test/build results, and any skipped integration checks. Distinguish a scripted replay, a local-model A2A exchange, a simulated PostgreSQL payment, and a Stripe test payment. Do not claim Stripe success from a simulated run or infer webhook delivery from a retrieved PaymentIntent. Never include secret values, raw `.env.local`, payment tokens, database dumps, or private account details in output or commits.
