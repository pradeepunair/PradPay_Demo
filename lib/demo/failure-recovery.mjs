import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { quoteDemoProduct } from "../a2a/merchant.mjs";
import { JourneyError } from "./local-journey.mjs";
import { durableLocalJourneyConfiguration } from "./durable-local-journey.mjs";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function createFailureRecoveryDemo({ env = process.env, pool, now = () => Date.now() } = {}) {
  if (!durableLocalJourneyConfiguration(env) || !pool?.query) throw new JourneyError("LOCAL_DEMO_DISABLED", 503);
  const stamp = () => new Date(now()).toISOString();
  const entry = (type, detail) => ({ type, detail, at: stamp() });

  async function owned(id, token) {
    if (!idPattern.test(id ?? "") || !idPattern.test(token ?? "")) throw new JourneyError("SCENARIO_NOT_FOUND", 404);
    const result = await pool.query(
      "SELECT snapshot FROM local_demo_scenarios WHERE id=$1 AND session_hash=$2 AND expires_at>now()",
      [id, hash(token)]);
    if (!result.rows[0]) throw new JourneyError("SCENARIO_NOT_FOUND", 404);
    return result.rows[0].snapshot;
  }

  return Object.freeze({
    async start(scenario) {
      if (!["merchant_refusal", "unknown_outcome"].includes(scenario)) throw new JourneyError("INVALID_SCENARIO", 400);
      const id = randomUUID(), token = randomUUID();
      const refusal = scenario === "merchant_refusal";
      const quote = refusal ? null : quoteDemoProduct({ productId: "aurora-pro", quantity: 1 }, new Date(now()));
      const stockDecision = refusal ? quoteDemoProduct({ productId: "signal-one", quantity: 1 }) : null;
      if (refusal && stockDecision?.reason !== "OUT_OF_STOCK") throw new JourneyError("SCENARIO_UNAVAILABLE", 503);
      if (!refusal && quote?.outcome !== "quoted") throw new JourneyError("SCENARIO_UNAVAILABLE", 503);
      const snapshot = { id, scenario, simulation: true,
        state: refusal ? "refused" : "payment_uncertain_simulated",
        mission: refusal ? "Ask for Signal One, which is out of stock." : "Recover an unknown test-payment outcome without retrying the payment.",
        quote, buyer: { model: "fixture", reason: refusal ? "Requested Signal One." : "Selected Aurora Pro Wireless." },
        merchant: { model: "catalog rule", reason: refusal ? "OUT_OF_STOCK: no quote or payment authority." : "Server-priced fictional quote." },
        protocolEvidence: null, payment: null, order: null, paymentEnabled: false, webhookReceipts: [],
        reconciliation: null, events: refusal ? [
          entry("run.started", "Simulated Buyer request; no model or Stripe call."),
          entry("a2a.request_fixture", "Example A2A message asks the Merchant for Signal One."),
          entry("a2a.refused", "Merchant catalog rule returned OUT_OF_STOCK. No quote or payment attempt exists."),
        ] : [
          entry("run.started", "Simulated Buyer and Merchant exchange; no model or Stripe call."),
          entry("a2a.quote_fixture", "Merchant catalog rule produced an illustrative quote."),
          entry("human.approval_fixture", "Example exact-amount approval; no real payment authority was granted."),
          entry("payment.reserved_fixture", "Illustrative attempt reserved. No Stripe request was sent."),
          entry("stripe.uncertain_fixture", "Example provider response was lost. Outcome remains unknown; do not retry."),
        ] };
      await pool.query(
        `INSERT INTO local_demo_scenarios(id,session_hash,scenario,snapshot,expires_at)
         VALUES ($1,$2,$3,$4::jsonb,$5)`, [id, hash(token), scenario, JSON.stringify(snapshot), new Date(now() + 86_400_000).toISOString()]);
      return { token, snapshot };
    },
    async read(id, token) { return owned(id, token); },
    async advance(id, token) {
      if (!idPattern.test(id ?? "") || !idPattern.test(token ?? "")) throw new JourneyError("SCENARIO_NOT_FOUND", 404);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          "SELECT snapshot FROM local_demo_scenarios WHERE id=$1 AND session_hash=$2 AND expires_at>now() FOR UPDATE",
          [id, hash(token)]);
        const snapshot = result.rows[0]?.snapshot;
        if (!snapshot) throw new JourneyError("SCENARIO_NOT_FOUND", 404);
        if (snapshot.scenario !== "unknown_outcome") throw new JourneyError("SCENARIO_NOT_RECOVERABLE", 409);
        if (snapshot.state === "payment_uncertain_simulated") {
          snapshot.state = "still_unknown_simulated";
          snapshot.events.push(entry("stripe.unresolved_fixture", "First read-only lookup found no matching evidence. Attempt remains unknown; no retry."));
        } else if (snapshot.state === "still_unknown_simulated") {
          snapshot.state = "recovered_simulated";
          snapshot.reconciliation = { outcome: "matched_fixture", checkedAt: stamp() };
          snapshot.order = { state: "confirmed", amountMinor: snapshot.quote.totalMinor, currency: "usd" };
          snapshot.events.push(entry("stripe.reconciled_fixture", "A later fixture supplies matching account, amount, currency, and run reference. Simulated order confirmed without a second payment."));
        }
        await client.query("UPDATE local_demo_scenarios SET snapshot=$2::jsonb,updated_at=now() WHERE id=$1",
          [id, JSON.stringify(snapshot)]);
        await client.query("COMMIT");
        return snapshot;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    },
  });
}

let cached;
export function getFailureRecoveryDemo(env = process.env) {
  if (!durableLocalJourneyConfiguration(env)) return null;
  if (!cached) {
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2, idleTimeoutMillis: 10_000 });
    pool.on("error", () => {});
    cached = createFailureRecoveryDemo({ env, pool });
  }
  return cached;
}
