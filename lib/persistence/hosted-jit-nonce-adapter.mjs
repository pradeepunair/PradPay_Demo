import {
  NONCE_REJECTION_CODES,
  NonceConsumptionRejection,
} from "../spike-guard/nonce-consumption-adapter.mjs";

export const HOSTED_JIT_NONCE_CONTRACT = Object.freeze({
  schema: "public",
  functionName: "consume_jit_nonce",
  signature: "consume_jit_nonce(text,text,text,text,text,text,text,text,text,timestamptz,timestamptz)",
  returnType: "text",
  sql: "SELECT public.consume_jit_nonce($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz) AS outcome",
  outcomes: Object.freeze(["consumed", "replay"]),
});

export const HOSTED_JIT_NONCE_FIELDS = Object.freeze([
  "nonce",
  "candidateCommit",
  "requestHash",
  "endpoint",
  "accountId",
  "paymentMethodFingerprint",
  "apiVersion",
  "acpVersion",
  "operatorIdentity",
  "issuedAt",
  "expiresAt",
]);

export const HOSTED_JIT_NONCE_PARAMETER_ORDER = Object.freeze([...HOSTED_JIT_NONCE_FIELDS]);

export const HOSTED_JIT_NONCE_SECRET_SOURCE = Object.freeze({
  kind: "direct-db",
  env: "PAYMENTLAB_DATABASE_URL",
});

export const HOSTED_JIT_NONCE_INTERFACE = Object.freeze({
  transactionAdapter: "{ withTransaction(work), consumeJitNonce(tx, orderedParameters) }",
  secretSource: "direct-db:PAYMENTLAB_DATABASE_URL",
  ordering: "consume_jit_nonce transaction commit -> admitted callback",
  defaultMode: "disabled",
  externalAction: "none",
});

const HOSTED_DISABLED = "HOSTED_NONCE_ADAPTER_DISABLED";
const REQUIRED_NONCE = /^[A-Za-z0-9_-]{16,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function fail(code, message, cause) {
  return new NonceConsumptionRejection(code, message, cause === undefined ? {} : { cause });
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("hosted JIT nonce receipt is required");
  }
  const keys = Object.keys(receipt).sort();
  const expected = [...HOSTED_JIT_NONCE_FIELDS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new TypeError("hosted JIT nonce receipt fields do not match the SQL contract");
  }
  if (typeof receipt.nonce !== "string" || !REQUIRED_NONCE.test(receipt.nonce)) throw new TypeError("nonce is invalid");
  if (typeof receipt.candidateCommit !== "string" || !COMMIT.test(receipt.candidateCommit)) throw new TypeError("candidateCommit is invalid");
  if (typeof receipt.requestHash !== "string" || !SHA256.test(receipt.requestHash)) throw new TypeError("requestHash is invalid");
  if (typeof receipt.paymentMethodFingerprint !== "string" || !SHA256.test(receipt.paymentMethodFingerprint)) throw new TypeError("paymentMethodFingerprint is invalid");
  for (const field of ["endpoint", "accountId", "apiVersion", "acpVersion", "operatorIdentity", "issuedAt", "expiresAt"]) {
    if (typeof receipt[field] !== "string" || receipt[field].trim() === "") throw new TypeError(`${field} is invalid`);
  }
  return Object.freeze({ ...receipt });
}

function parametersFor(receipt) {
  return Object.freeze(HOSTED_JIT_NONCE_PARAMETER_ORDER.map((field) => receipt[field]));
}

function classifyFailure(error) {
  if (error?.code === "DB_UNAVAILABLE" || error?.code === "ECONNREFUSED" || error?.code === "ETIMEDOUT") {
    return fail(NONCE_REJECTION_CODES.STORE_UNAVAILABLE, "hosted nonce store is unavailable", error);
  }
  if (error?.code === "TX_COMMIT_UNKNOWN" || error?.code === "TRANSACTION_AMBIGUOUS") {
    return fail(NONCE_REJECTION_CODES.TRANSACTION_AMBIGUOUS, "hosted nonce transaction outcome is ambiguous", error);
  }
  return error;
}

function classifyOutcome(outcome) {
  if (outcome === "consumed") return;
  if (outcome === "replay" || outcome === "duplicate") {
    return fail(NONCE_REJECTION_CODES.REPLAY, "hosted nonce has already been consumed");
  }
  throw new Error("hosted nonce function returned an invalid outcome");
}

function assertInjected(adapter) {
  if (typeof adapter?.withTransaction !== "function" || typeof adapter?.consumeJitNonce !== "function") {
    throw new TypeError("enabled hosted nonce adapter requires an injected transaction adapter");
  }
}

/**
 * Production-shaped port for the already-approved hosted function.
 *
 * This module contains no SQL client, network primitive, credentials, or
 * provider import. The hosted path is inert until both `enabled: true` and a
 * transaction adapter are explicitly injected by a future composition root.
 */
export function createHostedJitNonceAdapter({
  enabled = false,
  transactionAdapter,
  secretSource,
  effectGuard,
} = {}) {
  if (enabled) assertInjected(transactionAdapter);
  if (enabled && (secretSource?.kind !== HOSTED_JIT_NONCE_SECRET_SOURCE.kind
    || secretSource?.env !== HOSTED_JIT_NONCE_SECRET_SOURCE.env)) {
    throw new TypeError("enabled hosted nonce adapter requires the approved direct DB secret source");
  }

  const consume = async (input) => {
    const receipt = validateReceipt(input);
    if (!enabled) throw fail(HOSTED_DISABLED, "hosted nonce admission is disabled");
    if (!effectGuard || typeof effectGuard.assertAllowed !== "function") {
      throw fail("EFFECT_GUARD_REQUIRED", "hosted nonce effect capability requires an injected guard");
    }
    effectGuard.assertAllowed("hosted-nonce");
    let outcome;
    try {
      const parameters = parametersFor(receipt);
      outcome = await transactionAdapter.withTransaction((tx) => transactionAdapter.consumeJitNonce(tx, parameters));
    } catch (error) {
      throw classifyFailure(error);
    }
    const rejection = classifyOutcome(outcome?.status ?? outcome?.outcome);
    if (rejection) throw rejection;
    return Object.freeze({ status: "consumed", ...receipt });
  };

  const admit = async ({ receipt, onConsumed } = {}) => {
    if (typeof onConsumed !== "function") throw new TypeError("onConsumed callback is required");
    const committed = await consume(receipt);
    return onConsumed(committed);
  };

  return Object.freeze({ consume, admit, contract: HOSTED_JIT_NONCE_CONTRACT });
}
