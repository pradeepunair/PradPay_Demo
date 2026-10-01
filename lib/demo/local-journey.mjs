import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { quoteDemoProduct } from "../a2a/merchant.mjs";
import { classifyStripeEvent, verifyStripeEvent } from "../stripe-webhook.mjs";
import { runLocalA2A, LOCAL_DEMO_MISSION } from "./local-a2a.mjs";
import { matchPaymentIntent, reconcileStripeIntent, safePaymentIntent } from "./stripe-readonly.mjs";
import { runOneSandboxSPTPayment } from "../sandbox/stripe-spt-payment.mjs";
import { projectProtocolEvidence } from "./protocol-evidence.mjs";

export class JourneyError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const event = (type, detail) => ({ type, detail, at: new Date().toISOString() });

export function localJourneyConfiguration(env = process.env) {
  if (env.PAYMENTLAB_ENVIRONMENT !== "local" || env.PAYMENTLAB_LOCAL_DEMO_ENABLE !== "1") return null;
  if (env.PAYMENTLAB_LOCAL_DEMO_STORE === "postgres") {
    if (env.PAYMENTLAB_DATABASE_MODE !== "local") return null;
    try {
      const url = new URL(env.DATABASE_URL);
      if (!["postgres:", "postgresql:"].includes(url.protocol)
        || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return null;
    } catch { return null; }
    return { store: "postgres", paymentEnabled: env.PAYMENTLAB_LOCAL_STRIPE_PAYMENT_ENABLE === "1",
      accountId: env.PAYMENTLAB_STRIPE_ACCOUNT_ID };
  }
  if (env.PAYMENTLAB_LOCAL_DEMO_STORE && env.PAYMENTLAB_LOCAL_DEMO_STORE !== "file") return null;
  if (typeof env.PAYMENTLAB_LOCAL_DEMO_STATE_DIR !== "string"
    || !isAbsolute(env.PAYMENTLAB_LOCAL_DEMO_STATE_DIR)) return null;
  return { dir: env.PAYMENTLAB_LOCAL_DEMO_STATE_DIR,
    paymentEnabled: env.PAYMENTLAB_LOCAL_STRIPE_PAYMENT_ENABLE === "1",
    accountId: env.PAYMENTLAB_STRIPE_ACCOUNT_ID };
}

async function checkedDirectory(dir) {
  const stat = await lstat(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw new JourneyError("PRIVATE_STATE_DIR_REQUIRED", 503);
  }
}

async function persist(path, record, exclusive = false) {
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    await handle.close(); handle = null;
    if (!exclusive) await rename(target, path);
  } finally {
    await handle?.close();
    if (!exclusive) await unlink(target).catch(() => {});
  }
}

async function locked(path, operation) {
  const lockPath = `${path}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") throw new JourneyError("RUN_BUSY_OR_RECOVERY_REQUIRED");
    throw error;
  }
  try { return await operation(); }
  finally { await lock.close(); await unlink(lockPath); }
}

function safe(record) {
  return { id: record.id, state: record.state, mission: record.mission,
    quote: record.receipt?.quote ?? null,
    buyer: record.receipt?.buyer ?? null, merchant: record.receipt?.merchant ?? null,
    protocol: record.receipt?.protocol ?? null, payment: record.payment ?? null,
    protocolEvidence: projectProtocolEvidence(record.receipt?.protocolEvidence),
    events: record.events, paymentEnabled: record.paymentEnabled,
    reconciliation: record.reconciliation ?? null,
    webhookReceipts: record.webhookReceipts ?? [] };
}

function checkedQuote(record, quoteId, totalMinor, now) {
  const quote = record.receipt?.quote;
  if (!quote || quote.quoteId !== quoteId || quote.totalMinor !== totalMinor
    || quote.currency !== "usd" || !Number.isSafeInteger(now)
    || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now) {
    throw new JourneyError("QUOTE_EXPIRED_OR_CHANGED");
  }
  const current = quoteDemoProduct({ productId: quote.productId, quantity: 1 });
  for (const key of ["outcome", "catalogVersion", "productId", "productName", "quantity",
    "currency", "unitPriceMinor", "discountMinor", "shippingMinor", "taxMinor", "totalMinor"]) {
    if (quote[key] !== current[key]) throw new JourneyError("QUOTE_EXPIRED_OR_CHANGED");
  }
  return quote;
}

export function createLocalJourney({ env = process.env, runA2A = runLocalA2A,
  pay = runOneSandboxSPTPayment, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const config = localJourneyConfiguration(env);
  if (!config || config.store === "postgres") throw new JourneyError("LOCAL_DEMO_DISABLED", 503);
  const pathFor = (id) => {
    if (!idPattern.test(id ?? "")) throw new JourneyError("RUN_NOT_FOUND", 404);
    return join(config.dir, `${id}.json`);
  };
  async function readRecord(id) {
    let record;
    try { record = JSON.parse(await readFile(pathFor(id), "utf8")); }
    catch (error) {
      if (error instanceof JourneyError) throw error;
      throw new JourneyError(error?.code === "ENOENT" ? "RUN_NOT_FOUND" : "RUN_UNAVAILABLE",
        error?.code === "ENOENT" ? 404 : 503);
    }
    return record;
  }
  async function load(id, token) {
    if (!idPattern.test(token ?? "")) throw new JourneyError("SESSION_REQUIRED", 401);
    const record = await readRecord(id);
    if (record.sessionHash !== sha(token)) throw new JourneyError("RUN_NOT_FOUND", 404);
    return record;
  }
  async function readAttempt(id) {
    try { return JSON.parse(await readFile(join(config.dir, `${id}.attempt.json`), "utf8")); }
    catch { throw new JourneyError("ATTEMPT_UNAVAILABLE", 503); }
  }
  return Object.freeze({
    async start() {
      await checkedDirectory(config.dir);
      const id = randomUUID(), token = randomUUID(), path = pathFor(id);
      const record = { version: 1, id, sessionHash: sha(token), state: "generating",
        mission: LOCAL_DEMO_MISSION, paymentEnabled: config.paymentEnabled,
        events: [event("run.started", "Local model evaluation started; no payment authority.")] };
      await persist(path, record, true);
      try {
        const receipt = await runA2A({ mission: LOCAL_DEMO_MISSION });
        if (receipt?.provider !== "lmstudio" || receipt?.protocol !== "A2A 1.0 JSON-RPC"
          || receipt?.taskState !== "TASK_STATE_COMPLETED" || receipt?.paymentCalls !== 0
          || receipt?.buyer?.selectedProductId !== receipt?.quote?.productId
          || !receipt?.merchant || !receipt.quote?.quoteId) throw new JourneyError("A2A_RECEIPT_INVALID");
        record.receipt = receipt;
        checkedQuote(record, receipt.quote.quoteId, receipt.quote.totalMinor, now());
        record.state = "quoted";
        record.events.push(event("a2a.quote", "Buyer and Merchant exchanged an A2A JSON-RPC message; merchant issued a server-priced quote."));
      } catch (error) {
        record.state = "stopped";
        record.events.push(event("a2a.stopped", error instanceof JourneyError ? error.code : "A2A_UNAVAILABLE"));
      }
      await persist(path, record);
      return { token, snapshot: safe(record) };
    },
    async read(id, token) {
      await checkedDirectory(config.dir);
      return safe(await load(id, token));
    },
    async approve(id, token, { quoteId, totalMinor } = {}) {
      await checkedDirectory(config.dir);
      const path = pathFor(id);
      return locked(path, async () => {
        const record = await load(id, token);
        if (record.state !== "quoted") throw new JourneyError("RUN_NOT_AWAITING_APPROVAL");
        const quote = checkedQuote(record, quoteId, totalMinor, now());
        record.state = "approved";
        record.approvedQuoteHash = sha(JSON.stringify(quote));
        record.events.push(event("human.approved", `Approved exact USD ${(quote.totalMinor / 100).toFixed(2)} quote.`));
        await persist(path, record);
        return safe(record);
      });
    },
    async pay(id, token, apiKey) {
      await checkedDirectory(config.dir);
      if (!config.paymentEnabled) throw new JourneyError("SANDBOX_PAYMENT_DISABLED", 503);
      if (!/^acct_[A-Za-z0-9]{8,}$/.test(config.accountId ?? "")) throw new JourneyError("STRIPE_ACCOUNT_ID_REQUIRED", 503);
      const path = pathFor(id);
      const record = await locked(path, async () => {
        const current = await load(id, token);
        if (!current.paymentEnabled) throw new JourneyError("SANDBOX_PAYMENT_DISABLED", 503);
        if (current.state !== "approved") throw new JourneyError("PAYMENT_ALREADY_RESERVED_OR_NOT_APPROVED");
        const quote = checkedQuote(current, current.receipt.quote.quoteId, current.receipt.quote.totalMinor, now());
        if (sha(JSON.stringify(quote)) !== current.approvedQuoteHash) throw new JourneyError("QUOTE_EXPIRED_OR_CHANGED");
        if (typeof apiKey !== "string" || !apiKey.startsWith("sk_test_")) {
          throw new JourneyError("TEST_KEY_REQUIRED", 503);
        }
        current.state = "payment_reserved";
        current.events.push(event("payment.reserved", "One Stripe sandbox attempt reserved before dispatch."));
        await persist(path, current);
        return current;
      });
      let result;
      let failureCode;
      try {
        const quote = record.receipt.quote;
        result = await pay({ apiKey, accountId: config.accountId, receipt: record.receipt,
          approval: `usd:${quote.totalMinor}:${quote.productId}`,
          runId: id,
          attemptPath: join(config.dir, `${id}.attempt.json`) });
      } catch (error) {
        failureCode = error?.code ?? "PAYMENT_RESULT_UNCERTAIN";
      }
      return locked(path, async () => {
        const current = await load(id, token);
        if (result) {
          if (current.state !== "succeeded" || result.paymentStatus === "succeeded") {
            current.payment = result;
          }
          let attemptIntentId;
          try { attemptIntentId = (await readAttempt(id)).paymentIntentId; }
          catch { /* Retrieval already verified the result; retain the safe response. */ }
          if (current.providerIntentId && attemptIntentId && current.providerIntentId !== attemptIntentId) {
            throw new JourneyError("PROVIDER_EVIDENCE_MISMATCH");
          }
          current.providerIntentId = attemptIntentId ?? current.providerIntentId;
          if (current.state !== "succeeded") {
            current.state = result.paymentStatus === "succeeded" ? "succeeded" : "provider_pending";
          }
          current.events.push(event("stripe.retrieved", `Stripe test PaymentIntent status: ${result.paymentStatus}.`));
        } else {
          if (current.state !== "succeeded") current.state = "payment_uncertain";
          current.events.push(event("stripe.uncertain", failureCode));
        }
        await persist(path, current);
        return safe(current);
      });
    },
    async reconcile(id, token, apiKey) {
      await checkedDirectory(config.dir);
      const path = pathFor(id);
      return locked(path, async () => {
        const record = await load(id, token);
        if (!["payment_uncertain", "provider_pending"].includes(record.state)) {
          throw new JourneyError("RECONCILIATION_NOT_NEEDED");
        }
        const attempt = await readAttempt(id);
        const result = await reconcileStripeIntent({ apiKey, accountId: config.accountId, runId: id,
          quote: record.receipt?.quote,
          attempt: { ...attempt, paymentIntentId: record.providerIntentId ?? attempt.paymentIntentId },
          fetchImpl });
        record.reconciliation = { outcome: result.outcome, checkedAt: new Date(now()).toISOString() };
        if (result.outcome === "matched") {
          record.payment = result.payment;
          record.providerIntentId = result.paymentIntentId;
          record.state = result.payment.paymentStatus === "succeeded" ? "succeeded" : "provider_pending";
          record.events.push(event("stripe.reconciled", `Read-only Stripe status: ${result.payment.paymentStatus}.`));
        }
        await persist(path, record);
        return safe(record);
      });
    },
    async receiveWebhook({ rawBody, signature, endpointSecret }) {
      await checkedDirectory(config.dir);
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
      const path = pathFor(id);
      return locked(path, async () => {
        const record = await readRecord(id);
        const attempt = await readAttempt(id);
        if (attempt.runId !== id || attempt.amountMinor !== record.receipt?.quote?.totalMinor
          || attempt.quoteHash !== sha(JSON.stringify(record.receipt?.quote))
          || record.approvedQuoteHash !== attempt.quoteHash
          || (attempt.paymentIntentId && intent?.id !== attempt.paymentIntentId)
          || (record.providerIntentId && intent?.id !== record.providerIntentId)
          || !matchPaymentIntent(intent, { runId: id, quote: record.receipt?.quote,
            quoteHash: attempt.quoteHash })) {
          throw new JourneyError("WEBHOOK_EVIDENCE_MISMATCH", 400);
        }
        if (stripeEvent.type === "payment_intent.succeeded" && intent.status !== "succeeded") {
          throw new JourneyError("WEBHOOK_EVIDENCE_MISMATCH", 400);
        }
        const receipts = record.webhookReceipts ?? [];
        const previous = receipts.find((receipt) => receipt.eventId === stripeEvent.id);
        if (previous) {
          if (previous.payloadSha256 !== sha(rawBody)) throw new JourneyError("WEBHOOK_EVENT_CONFLICT", 400);
          return { disposition: "duplicate" };
        }
        if (receipts.length >= 64) throw new JourneyError("WEBHOOK_RECEIPT_LIMIT", 503);
        const receipt = { eventId: stripeEvent.id, type: stripeEvent.type,
          providerCreatedAt: stripeEvent.created,
          payloadSha256: sha(rawBody), receivedAt: new Date(now()).toISOString(),
          paymentIntentSuffix: intent.id.slice(-8) };
        record.webhookReceipts = [...receipts, receipt];
        record.providerIntentId = intent.id;
        record.events.push(event("webhook.verified", `Verified Stripe signature and ${stripeEvent.type} for this run.`));
        if (stripeEvent.type === "payment_intent.succeeded"
          && ["payment_uncertain", "provider_pending", "payment_reserved"].includes(record.state)) {
          record.payment = safePaymentIntent(intent, config.accountId);
          record.state = "succeeded";
          record.events.push(event("stripe.webhook_confirmed", "Signed Stripe event confirmed the test payment."));
        }
        await persist(path, record);
        return { disposition: "recorded" };
      });
    },
  });
}
