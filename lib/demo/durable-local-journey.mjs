import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

import { quoteDemoProduct } from "../a2a/merchant.mjs";
import { classifyStripeEvent, verifyStripeEvent } from "../stripe-webhook.mjs";
import { runOneSandboxSPTPayment } from "../sandbox/stripe-spt-payment.mjs";
import { JourneyError } from "./local-journey.mjs";
import { runLocalA2A, LOCAL_DEMO_MISSION } from "./local-a2a.mjs";
import { matchPaymentIntent, reconcileStripeIntent, safePaymentIntent } from "./stripe-readonly.mjs";
import { projectProtocolEvidence } from "./protocol-evidence.mjs";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const ids = (runId) => ({ checkout: `checkout_${runId}`, mandate: `mandate_${runId}`,
  order: `order_${runId}`, payment: `payment_${runId}`, attempt: `attempt_${runId}` });
const event = (type, detail) => ({ type, detail, at: new Date().toISOString() });

export function durableLocalJourneyConfiguration(env = process.env) {
  if (env.PAYMENTLAB_ENVIRONMENT !== "local" || env.PAYMENTLAB_LOCAL_DEMO_ENABLE !== "1"
    || env.PAYMENTLAB_LOCAL_DEMO_STORE !== "postgres" || env.PAYMENTLAB_DATABASE_MODE !== "local") return null;
  try {
    const url = new URL(env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return null;
  } catch { return null; }
  return { paymentEnabled: env.PAYMENTLAB_LOCAL_STRIPE_PAYMENT_ENABLE === "1",
    accountId: env.PAYMENTLAB_STRIPE_ACCOUNT_ID };
}

export function createDurableLocalJourney({ env = process.env, pool,
  runA2A = runLocalA2A, pay = runOneSandboxSPTPayment,
  fetchImpl = fetch, now = () => Date.now() } = {}) {
  const config = durableLocalJourneyConfiguration(env);
  if (!config) throw new JourneyError("LOCAL_DEMO_DISABLED", 503);
  if (!pool || typeof pool.connect !== "function") throw new TypeError("pool.connect is required");

  async function transaction(work) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const result = await work(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { tx.release(); }
  }

  async function load(tx, id, token, lock = false) {
    if (!idPattern.test(id ?? "")) throw new JourneyError("RUN_NOT_FOUND", 404);
    if (token !== null && !idPattern.test(token ?? "")) throw new JourneyError("SESSION_REQUIRED", 401);
    const result = await tx.query(
      `SELECT j.snapshot,j.session_id,v.expires_at
         FROM local_demo_journeys j JOIN visitor_sessions v ON v.id=j.session_id
        WHERE j.run_id=$1 ${lock ? "FOR UPDATE OF j" : ""}`, [id]);
    const row = result.rows[0];
    if (!row) throw new JourneyError("RUN_NOT_FOUND", 404);
    if (token !== null && (row.session_id !== sha(token) || Date.parse(row.expires_at) <= now())) {
      throw new JourneyError("RUN_NOT_FOUND", 404);
    }
    return row.snapshot;
  }

  async function save(tx, record, runState) {
    const updated = await tx.query(
      "UPDATE local_demo_journeys SET snapshot=$2::jsonb,updated_at=now() WHERE run_id=$1 RETURNING run_id",
      [record.id, JSON.stringify(record)]);
    if (updated.rowCount !== 1) throw new JourneyError("RUN_UNAVAILABLE", 503);
    if (runState) await tx.query("UPDATE runs SET state=$2,updated_at=now() WHERE id=$1", [record.id, runState]);
  }

  async function append(tx, record, type, detail) {
    record.events.push(event(type, detail));
    await tx.query("SELECT append_domain_event($1,$2,$3,$4,$5,$6::jsonb)",
      [randomUUID(), record.id, record.sessionHash, type, "1.0.0", JSON.stringify({ detail })]);
  }

  function safe(record) {
    return { id: record.id, state: record.state, mission: record.mission,
      quote: record.receipt?.quote ?? null, buyer: record.receipt?.buyer ?? null,
      merchant: record.receipt?.merchant ?? null, protocol: record.receipt?.protocol ?? null,
      protocolEvidence: projectProtocolEvidence(record.receipt?.protocolEvidence),
      payment: record.payment ?? null, order: record.order ?? null,
      events: record.events, paymentEnabled: record.paymentEnabled,
      reconciliation: record.reconciliation ?? null, webhookReceipts: record.webhookReceipts ?? [] };
  }

  function checkedQuote(record, quoteId, totalMinor) {
    const quote = record.receipt?.quote;
    if (!quote || quote.quoteId !== quoteId || quote.totalMinor !== totalMinor
      || quote.currency !== "usd" || !Number.isFinite(Date.parse(quote.expiresAt))
      || Date.parse(quote.expiresAt) <= now()) {
      throw new JourneyError("QUOTE_EXPIRED_OR_CHANGED");
    }
    const current = quoteDemoProduct({ productId: quote.productId, quantity: 1 });
    for (const key of ["outcome", "catalogVersion", "productId", "productName", "quantity",
      "currency", "unitPriceMinor", "discountMinor", "shippingMinor", "taxMinor", "totalMinor"]) {
      if (quote[key] !== current[key]) throw new JourneyError("QUOTE_EXPIRED_OR_CHANGED");
    }
    return quote;
  }

  async function attempt(tx, runId, lock = false) {
    const result = await tx.query(
      `SELECT a.*,j.journal FROM payment_attempts a
         LEFT JOIN local_demo_attempt_journals j ON j.attempt_id=a.id
        WHERE a.run_id=$1 AND a.id=$2 ${lock ? "FOR UPDATE OF a" : ""}`,
      [runId, ids(runId).attempt]);
    return result.rows[0] ?? null;
  }

  async function confirm(tx, record, providerIntentId, payment) {
    if (!/^pi_[A-Za-z0-9]+$/.test(providerIntentId ?? "")
      || payment.paymentStatus !== "succeeded" || payment.amountMinor !== record.receipt.quote.totalMinor
      || payment.currency !== "usd" || payment.paymentIntentSuffix !== providerIntentId.slice(-8)
      || payment.accountId !== config.accountId || payment.livemode !== false) {
      throw new JourneyError("PROVIDER_EVIDENCE_MISMATCH", 400);
    }
    const a = await attempt(tx, record.id, true);
    if (!a || (a.provider_reference && a.provider_reference !== providerIntentId)
      || (record.providerIntentId && record.providerIntentId !== providerIntentId)) {
      throw new JourneyError("PROVIDER_EVIDENCE_MISMATCH", 400);
    }
    if (record.state === "succeeded") return;
    const key = ids(record.id);
    await tx.query("UPDATE payment_attempts SET state='succeeded',provider_state='succeeded',provider_reference=$2,updated_at=now() WHERE id=$1", [key.attempt, providerIntentId]);
    await tx.query("UPDATE payments SET provider='stripe',provider_reference=$2 WHERE id=$1", [key.payment, providerIntentId]);
    await tx.query("UPDATE mandate_usages SET status='succeeded',updated_at=now() WHERE attempt_id=$1", [key.attempt]);
    await tx.query("UPDATE mandates SET state='consumed' WHERE id=$1", [key.mandate]);
    await tx.query("UPDATE orders SET state='confirmed',evidence_source='stripe_test_verified',updated_at=now() WHERE id=$1", [key.order]);
    await tx.query("UPDATE checkouts SET state='completed',updated_at=now() WHERE id=$1", [key.checkout]);
    await tx.query("UPDATE reconciliation_jobs SET state='resolved',updated_at=now() WHERE attempt_id=$1", [key.attempt]);
    record.providerIntentId = providerIntentId;
    record.payment = payment;
    record.order = { state: "confirmed", amountMinor: payment.amountMinor,
      currency: "usd", evidenceSource: "stripe_test_verified" };
    record.state = "succeeded";
  }

  function attemptStore(runId) {
    return {
      async create(journal) {
        await transaction(async (tx) => {
          const record = await load(tx, runId, null, true);
          const a = await attempt(tx, runId, true);
          if (!a || record.state !== "payment_reserved" || journal.runId !== runId
            || journal.amountMinor !== record.receipt?.quote?.totalMinor
            || journal.quoteHash !== record.approvedQuoteHash || journal.accountId !== config.accountId) {
            throw new JourneyError("ATTEMPT_MISMATCH", 409);
          }
          const result = await tx.query(
            "INSERT INTO local_demo_attempt_journals(run_id,attempt_id,journal) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING run_id",
            [runId, a.id, JSON.stringify(journal)]);
          if (result.rowCount !== 1) throw new JourneyError("ATTEMPT_ALREADY_EXISTS", 409);
        });
      },
      async update(journal) {
        await transaction(async (tx) => {
          const a = await attempt(tx, runId, true);
          if (!a?.journal || a.journal.runId !== runId
            || a.journal.quoteHash !== journal.quoteHash
            || (a.provider_reference && journal.paymentIntentId
              && a.provider_reference !== journal.paymentIntentId)) {
            throw new JourneyError("ATTEMPT_MISMATCH", 409);
          }
          const state = /uncertain|invalid|rejected/.test(journal.state) ? "unknown" : "submitted";
          await tx.query(
            `UPDATE payment_attempts SET state=CASE WHEN state='succeeded' THEN state ELSE $2 END,
               provider_reference=COALESCE(provider_reference,$3),updated_at=now() WHERE id=$1`,
            [a.id, state, journal.paymentIntentId ?? null]);
          await tx.query("UPDATE local_demo_attempt_journals SET journal=$2::jsonb,updated_at=now() WHERE run_id=$1",
            [runId, JSON.stringify(journal)]);
        });
      },
    };
  }

  return Object.freeze({
    async start() {
      const id = randomUUID(), token = randomUUID(), sessionHash = sha(token);
      const record = { version: 2, id, sessionHash, state: "generating", mission: LOCAL_DEMO_MISSION,
        paymentEnabled: config.paymentEnabled, events: [] };
      await transaction(async (tx) => {
        await tx.query("INSERT INTO visitor_sessions(id,expires_at,admission_limit,admitted_count) VALUES ($1,$2,1,1)",
          [sessionHash, new Date(now() + 86_400_000).toISOString()]);
        await tx.query(
          `INSERT INTO runs(id,session_id,mode,scenario,state,reference_time,schema_version)
           VALUES ($1,$2,'live_sandbox','local_a2a_spt_helper','running',$3,'1.0.0')`,
          [id, sessionHash, new Date(now()).toISOString()]);
        await tx.query("INSERT INTO local_demo_journeys(run_id,session_id,snapshot) VALUES ($1,$2,$3::jsonb)",
          [id, sessionHash, JSON.stringify(record)]);
        await append(tx, record, "run.started", "Local model evaluation started; no payment authority.");
        await save(tx, record);
      });
      let receipt;
      try { receipt = await runA2A({ mission: LOCAL_DEMO_MISSION }); }
      catch { /* Record a stopped run below. */ }
      return transaction(async (tx) => {
        const current = await load(tx, id, token, true);
        let receiptError = receipt ? null : "A2A_UNAVAILABLE";
        if (receipt) {
          try {
            if (receipt.provider !== "lmstudio" || receipt.protocol !== "A2A 1.0 JSON-RPC"
              || receipt.taskState !== "TASK_STATE_COMPLETED" || receipt.paymentCalls !== 0
              || receipt.buyer?.selectedProductId !== receipt.quote?.productId
              || !receipt.merchant || !receipt.quote?.quoteId) throw new JourneyError("A2A_RECEIPT_INVALID");
            current.receipt = receipt;
            checkedQuote(current, receipt.quote.quoteId, receipt.quote.totalMinor);
          } catch (error) { receiptError = error instanceof JourneyError ? error.code : "A2A_RECEIPT_INVALID"; }
        }
        if (!receiptError) {
          const quote = receipt.quote, key = ids(id);
          const cartHash = sha(JSON.stringify({ productId: quote.productId, quantity: 1, totalMinor: quote.totalMinor }));
          await tx.query(
            `INSERT INTO checkouts(id,session_id,run_id,acp_version,state,cart_hash)
             VALUES ($1,$2,$3,'local-demo-v1','quoted',$4)`,
            [key.checkout, sessionHash, id, cartHash]);
          await tx.query(
            `INSERT INTO quotes(id,checkout_id,version,currency,subtotal_minor,shipping_minor,tax_minor,total_minor,expires_at,assumptions)
             VALUES ($1,$2,1,'USD',$3,$4,$5,$6,$7,$8::jsonb)`,
            [quote.quoteId, key.checkout, quote.unitPriceMinor - quote.discountMinor,
              quote.shippingMinor, quote.taxMinor, quote.totalMinor, quote.expiresAt,
              JSON.stringify({ catalogVersion: quote.catalogVersion, productId: quote.productId })]);
          current.state = "quoted";
          await append(tx, current, "a2a.quote", "Buyer and Merchant exchanged an A2A JSON-RPC message; merchant issued a server-priced quote.");
          await save(tx, current, "awaiting_permission");
        } else {
          current.state = "stopped";
          delete current.receipt;
          await append(tx, current, "a2a.stopped", receiptError);
          await save(tx, current, "failed");
        }
        return { token, snapshot: safe(current) };
      });
    },
    async read(id, token) {
      return transaction(async (tx) => safe(await load(tx, id, token)));
    },
    async approve(id, token, { quoteId, totalMinor } = {}) {
      return transaction(async (tx) => {
        const record = await load(tx, id, token, true);
        if (record.state !== "quoted") throw new JourneyError("RUN_NOT_AWAITING_APPROVAL");
        const quote = checkedQuote(record, quoteId, totalMinor);
        const key = ids(id);
        record.approvedQuoteHash = sha(JSON.stringify(quote));
        await tx.query(
          `INSERT INTO mandates(id,session_id,run_id,checkout_id,version,state,approved_text,constraints,currency,maximum_amount_minor,expires_at)
           VALUES ($1,$2,$3,$4,1,'active',$5,$6::jsonb,'USD',$7,$8)`,
          [key.mandate, record.sessionHash, id, key.checkout,
            `Approved exact USD ${(quote.totalMinor / 100).toFixed(2)} quote.`,
            JSON.stringify({ quoteHash: record.approvedQuoteHash, productId: quote.productId }),
            quote.totalMinor, quote.expiresAt]);
        await tx.query("UPDATE checkouts SET state='ready',updated_at=now() WHERE id=$1", [key.checkout]);
        record.state = "approved";
        await append(tx, record, "human.approved", `Approved exact USD ${(quote.totalMinor / 100).toFixed(2)} quote.`);
        await save(tx, record, "awaiting_payment");
        return safe(record);
      });
    },
    async pay(id, token, apiKey) {
      if (!config.paymentEnabled) throw new JourneyError("SANDBOX_PAYMENT_DISABLED", 503);
      if (typeof apiKey !== "string" || !apiKey.startsWith("sk_test_")) throw new JourneyError("TEST_KEY_REQUIRED", 503);
      if (!/^acct_[A-Za-z0-9]{8,}$/.test(config.accountId ?? "")) throw new JourneyError("STRIPE_ACCOUNT_ID_REQUIRED", 503);
      const reserved = await transaction(async (tx) => {
        const record = await load(tx, id, token, true);
        if (!record.paymentEnabled) throw new JourneyError("SANDBOX_PAYMENT_DISABLED", 503);
        if (record.state !== "approved") throw new JourneyError("PAYMENT_ALREADY_RESERVED_OR_NOT_APPROVED");
        const quote = checkedQuote(record, record.receipt.quote.quoteId, record.receipt.quote.totalMinor);
        if (sha(JSON.stringify(quote)) !== record.approvedQuoteHash) throw new JourneyError("QUOTE_EXPIRED_OR_CHANGED");
        const key = ids(id);
        await tx.query(
          `INSERT INTO orders(id,session_id,run_id,checkout_id,state,currency,amount_minor)
           VALUES ($1,$2,$3,$4,'pending_payment','USD',$5)`,
          [key.order, record.sessionHash, id, key.checkout, quote.totalMinor]);
        await tx.query(
          `INSERT INTO payments(id,session_id,run_id,checkout_id,order_id,currency,amount_minor)
           VALUES ($1,$2,$3,$4,$5,'USD',$6)`,
          [key.payment, record.sessionHash, id, key.checkout, key.order, quote.totalMinor]);
        await tx.query(
          `INSERT INTO payment_attempts(id,session_id,run_id,checkout_id,payment_id,mandate_id,operation_key,request_hash,state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'prepared')`,
          [key.attempt, record.sessionHash, id, key.checkout, key.payment, key.mandate,
            `paymentlab-payment-${id}`, sha(JSON.stringify({ id, quoteHash: record.approvedQuoteHash, amountMinor: quote.totalMinor }))]);
        await tx.query("INSERT INTO mandate_usages(id,mandate_id,attempt_id,status) VALUES ($1,$2,$3,'reserved')",
          [`usage_${id}`, key.mandate, key.attempt]);
        await tx.query(
          `INSERT INTO reconciliation_jobs(id,session_id,run_id,attempt_id,state)
           VALUES ($1,$2,$3,$4,'pending')`, [`reconcile_${id}`, record.sessionHash, id, key.attempt]);
        await tx.query("UPDATE mandates SET state='reserved' WHERE id=$1", [key.mandate]);
        await tx.query("UPDATE checkouts SET state='completing',updated_at=now() WHERE id=$1", [key.checkout]);
        record.state = "payment_reserved";
        record.order = { state: "pending_payment", amountMinor: quote.totalMinor, currency: "usd" };
        await append(tx, record, "payment.reserved", "One Stripe sandbox attempt and pending order reserved before dispatch.");
        await save(tx, record);
        return record;
      });
      let result;
      let failureCode;
      try {
        const quote = reserved.receipt.quote;
        result = await pay({ apiKey, accountId: config.accountId, receipt: reserved.receipt,
          approval: `usd:${quote.totalMinor}:${quote.productId}`, runId: id,
          attemptStore: attemptStore(id) });
      } catch (error) { failureCode = error?.code ?? "PAYMENT_RESULT_UNCERTAIN"; }
      return transaction(async (tx) => {
        const record = await load(tx, id, token, true);
        const a = await attempt(tx, id, true);
        if (result?.paymentStatus === "succeeded" && a?.journal?.paymentIntentId
          && a.journal.state === "provider_confirmed_succeeded") {
          await confirm(tx, record, a.journal.paymentIntentId, result);
          await append(tx, record, "stripe.retrieved", "Stripe test PaymentIntent status: succeeded.");
        } else if (record.state !== "succeeded") {
          const terminal = ["canceled", "requires_payment_method"].includes(result?.paymentStatus);
          record.state = terminal ? "provider_failed" : result ? "provider_pending" : "payment_uncertain";
          await tx.query("UPDATE payment_attempts SET state=$2,updated_at=now() WHERE id=$1 AND state<>'succeeded'",
            [ids(id).attempt, terminal ? result.paymentStatus === "canceled" ? "canceled" : "failed" : result ? "processing" : "unknown"]);
          await append(tx, record, result ? "stripe.retrieved" : "stripe.uncertain",
            result ? `Stripe test PaymentIntent status: ${result.paymentStatus}.` : failureCode);
        }
        await save(tx, record, record.state === "succeeded" ? "succeeded" : "awaiting_payment");
        return safe(record);
      });
    },
    async reconcile(id, token, apiKey) {
      const input = await transaction(async (tx) => {
        const record = await load(tx, id, token);
        if (!["payment_reserved", "payment_uncertain", "provider_pending"].includes(record.state)) {
          throw new JourneyError("RECONCILIATION_NOT_NEEDED");
        }
        const a = await attempt(tx, id);
        if (!a) throw new JourneyError("ATTEMPT_UNAVAILABLE", 503);
        return { quote: record.receipt.quote, quoteHash: record.approvedQuoteHash,
          providerIntentId: a.provider_reference ?? a.journal?.paymentIntentId };
      });
      const result = await reconcileStripeIntent({ apiKey, accountId: config.accountId, runId: id, quote: input.quote,
        attempt: { runId: id, amountMinor: input.quote.totalMinor, currency: "usd",
          quoteHash: input.quoteHash, paymentIntentId: input.providerIntentId }, fetchImpl });
      return transaction(async (tx) => {
        const record = await load(tx, id, token, true);
        if (record.state === "succeeded") return safe(record);
        record.reconciliation = { outcome: result.outcome, checkedAt: new Date(now()).toISOString() };
        if (result.outcome === "matched") {
          if (result.payment.paymentStatus === "succeeded") {
            await confirm(tx, record, result.paymentIntentId, result.payment);
          } else {
            const terminal = ["canceled", "requires_payment_method"].includes(result.payment.paymentStatus);
            record.state = terminal ? "provider_failed" : "provider_pending";
            record.payment = result.payment;
            record.providerIntentId = result.paymentIntentId;
            await tx.query("UPDATE payment_attempts SET state=$2,provider_reference=$3,updated_at=now() WHERE id=$1",
              [ids(id).attempt, terminal ? result.payment.paymentStatus === "canceled" ? "canceled" : "failed" : "processing", result.paymentIntentId]);
          }
          await append(tx, record, "stripe.reconciled", `Read-only Stripe status: ${result.payment.paymentStatus}.`);
        } else {
          record.state = "payment_uncertain";
          await tx.query("UPDATE payment_attempts SET state='unknown',updated_at=now() WHERE id=$1",
            [ids(id).attempt]);
        }
        await save(tx, record, record.state === "succeeded" ? "succeeded" : "awaiting_payment");
        return safe(record);
      });
    },
    async receiveWebhook({ rawBody, signature, endpointSecret }) {
      if (typeof endpointSecret !== "string" || !endpointSecret.startsWith("whsec_")) {
        throw new JourneyError("WEBHOOK_NOT_CONFIGURED", 503);
      }
      let stripeEvent;
      try { stripeEvent = verifyStripeEvent({ rawBody, signature, endpointSecret }); }
      catch { throw new JourneyError("WEBHOOK_SIGNATURE_INVALID", 400); }
      const classification = classifyStripeEvent(stripeEvent);
      if (!classification.accepted) throw new JourneyError("LIVE_WEBHOOK_DENIED", 400);
      if (!stripeEvent.type?.startsWith("payment_intent.")
        || classification.disposition === "ignored") return { disposition: "ignored" };
      const intent = stripeEvent.data?.object;
      const id = intent?.metadata?.paymentlab_run_id;
      if (!idPattern.test(id ?? "")) return { disposition: "ignored_foreign" };
      if (!/^evt_[A-Za-z0-9]{1,128}$/.test(stripeEvent.id ?? "")
        || !Number.isSafeInteger(stripeEvent.created) || stripeEvent.created < 1) {
        throw new JourneyError("WEBHOOK_ENVELOPE_INVALID", 400);
      }
      return transaction(async (tx) => {
        let record;
        try { record = await load(tx, id, null, true); }
        catch (error) {
          if (error?.code === "RUN_NOT_FOUND") return { disposition: "ignored_foreign" };
          throw error;
        }
        const a = await attempt(tx, id, true);
        if (!a || !record.approvedQuoteHash
          || record.approvedQuoteHash !== sha(JSON.stringify(record.receipt?.quote))
          || (a.provider_reference && a.provider_reference !== intent?.id)
          || (record.providerIntentId && record.providerIntentId !== intent?.id)
          || !matchPaymentIntent(intent, { runId: id, quote: record.receipt?.quote,
            quoteHash: record.approvedQuoteHash })
          || (stripeEvent.type === "payment_intent.succeeded" && intent.status !== "succeeded")) {
          throw new JourneyError("WEBHOOK_EVIDENCE_MISMATCH", 400);
        }
        const previous = await tx.query(
          "SELECT safe_payload FROM webhook_receipts WHERE provider='stripe' AND provider_event_id=$1",
          [stripeEvent.id]);
        const payloadSha256 = sha(rawBody);
        if (previous.rows[0]) {
          if (previous.rows[0].safe_payload?.payloadSha256 !== payloadSha256) {
            throw new JourneyError("WEBHOOK_EVENT_CONFLICT", 400);
          }
          return { disposition: "duplicate" };
        }
        const receipt = { eventId: stripeEvent.id, type: stripeEvent.type,
          providerCreatedAt: stripeEvent.created, payloadSha256,
          receivedAt: new Date(now()).toISOString(), paymentIntentSuffix: intent.id.slice(-8) };
        await tx.query(
          `INSERT INTO webhook_receipts(id,provider,provider_event_id,event_type,state,safe_payload,occurred_at)
           VALUES ($1,'stripe',$2,$3,$4,$5::jsonb,$6)`,
          [randomUUID(), stripeEvent.id, stripeEvent.type,
            stripeEvent.type === "payment_intent.succeeded" ? "applied" : "verified",
            JSON.stringify({ runId: id, payloadSha256, paymentIntentSuffix: receipt.paymentIntentSuffix }),
            new Date(stripeEvent.created * 1000).toISOString()]);
        record.webhookReceipts = [...(record.webhookReceipts ?? []), receipt];
        await append(tx, record, "webhook.verified", `Verified Stripe signature and ${stripeEvent.type} for this run.`);
        if (stripeEvent.type === "payment_intent.succeeded") {
          const wasSucceeded = record.state === "succeeded";
          await confirm(tx, record, intent.id, safePaymentIntent(intent, config.accountId));
          if (!wasSucceeded) await append(tx, record, "stripe.webhook_confirmed", "Signed Stripe event confirmed the test payment.");
        }
        await save(tx, record, record.state === "succeeded" ? "succeeded" : null);
        return { disposition: "recorded" };
      });
    },
  });
}

let cached;
export function getDurableLocalJourney(env = process.env) {
  if (!durableLocalJourneyConfiguration(env)) return null;
  if (!cached) {
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 4, idleTimeoutMillis: 10_000 });
    pool.on("error", () => {});
    cached = createDurableLocalJourney({ env, pool });
  }
  return cached;
}
