# PradPay Demo

A local, inspectable agent-to-agent commerce simulation. The Agent Interaction Studio at `/simulation` walks through a fictional buyer mission, merchant quote, exact human approval, simulated payment, recovery scenarios, narration, and evidence replay. Its default mode is scripted and **needs no Stripe account, database, model, or API key**.

An optional `/local-sandbox` path runs Buyer and Merchant decisions against your own LM Studio server and exchanges a quote through the open A2A JSON-RPC protocol. A separate, opt-in button can submit **one Stripe test-mode payment** using Stripe's seller-side Shared Payment Token (SPT) test helper. That helper simulates token issuance; the Buyer agent does not issue a Stripe token. No real money or fulfillment is involved.

## Quick start: scripted simulation

Prerequisites: Node.js 22 and npm. From this repository:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open [http://127.0.0.1:3000/simulation](http://127.0.0.1:3000/simulation). Choose a teaching scenario, advance exchanges manually or use auto-play, and inspect the shared evidence trail. The scripted payment and token are fictional. No external service is called.

## Optional paths

| Path | Additional prerequisites | Setup |
| --- | --- | --- |
| LM Studio product suggestion inside `/simulation` | LM Studio, a loaded model, local server | [Local model guide](docs/LOCAL-MODEL.md) |
| Durable simulated payment in `/simulation` | Local PostgreSQL | [PostgreSQL guide](docs/POSTGRES.md) |
| Live local A2A quote at `/local-sandbox` | LM Studio, private local state directory | [Local model and A2A guide](docs/LOCAL-MODEL.md) |
| Stripe sandbox payment from `/local-sandbox` | Stripe sandbox with eligible SPT test-helper access and a US test account; optional Stripe CLI for webhook delivery | [Stripe guide](docs/STRIPE-SANDBOX.md) |

These paths are independent. PostgreSQL is optional for the Studio's simulated payment and for the local A2A journey; the A2A journey can use owner-only files. Stripe is never required to try the Studio. The local A2A journey requires a model; it does not silently switch to a paid provider.

## Demo walkthrough

1. Open `/simulation` and review the fictional Buyer intent and catalog constraints.
2. Advance through the Buyer–Merchant exchanges and compare their views.
3. Approve the exact quote and issue the **fictional** payment authority.
4. Pick success, decline, duplicate callback, or timeout/recovery in the teaching scenario. Advance through the outcome and inspect the evidence trail.
5. Optionally enable LM Studio to compare a local model's product suggestion with the deterministic quote and constraints.
6. For an actual A2A exchange and optional Stripe test payment, follow the separate `/local-sandbox` guide. Review the exact amount and press the payment button once; no payment occurs while exploring the Studio.

## Boundaries and project layout

- `app/simulation`, `components/agent-simulation*`, `lib/replay/agent-simulation*`: scripted Studio and replay.
- `lib/a2a`, `lib/demo/local-a2a.mjs`: local Merchant A2A server and Buyer client.
- `app/local-sandbox`, `lib/demo/local-journey*`: optional local quote, approval, and payment journey.
- `lib/sandbox/stripe-spt-payment.mjs`: test-only seller helper and single-attempt Stripe dispatch.
- `db/migrations`: optional local PostgreSQL schema.
- `.env.example`: variable names and safe defaults only. Put real values in ignored `.env.local`; never commit it.

The repository also contains supporting ACP, replay, and reliability modules from the original prototype. They are **not** an assertion of production readiness or broad protocol interoperability. The tested demo is local and intentionally bounded to a fictional catalog, USD quotes, explicit approval, and test-mode payment rails.

## Verify

```sh
npm run demo:test
npm run build
```

The tests use local fixtures and never call Stripe or a paid model. To run Postgres-specific tests or verify a live webhook, use a disposable local database and your own sandbox as described in the guides.

If a path returns `LOCAL_DEMO_DISABLED`, check the local flags and restart Next.js after editing `.env.local`. If LM Studio shows `Unexpected endpoint or method (GET /)`, that only means the root URL is not an API route; test `http://127.0.0.1:1234/v1/models` instead.

This public demo contains no real credentials, personal run records, or provider receipts. Please use your own sandbox and keep `.env.local`, database dumps, and screenshots with account details private.
