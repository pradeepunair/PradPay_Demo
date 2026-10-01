import { createHmac, timingSafeEqual } from "node:crypto";
import { FROZEN_REQUEST_HASH, FROZEN_SPIKE_REQUEST, assertExactSpikeRequest } from "./request.mjs";
import { CLOCK_AUTHORITY, MAX_ACTION_LEASE_SECONDS, createApprovalLease, assertActiveLease } from "./state.mjs";
import { assertExecutionEpoch, parseSntpSample } from "./clock.mjs";
import { SAFE_EXECUTION_FAILURE_MESSAGE } from "./safe-errors.mjs";

export const RECEIPT_ENVELOPE_VERSION = "l-gate-receipt-v1";
export const LIVE_AUTHORITY_DISABLED_MESSAGE = "Live native authority is disabled; no credential or provider action is permitted.";
const COMMIT = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,256}$/;
const IDENTITY_KEYS = ["account", "profile", "operatorIdentity", "ownerIdentity", "testMode"];
const ENVELOPE_KEYS = ["version", "payload", "signature"];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is required`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} fields are not exact`);
}
function canonical(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt payload must be an object");
  const keys = Object.keys(value).sort();
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, value[key]])));
}
function b64(value) { return Buffer.from(value, "utf8").toString("base64url"); }
function unb64(value) { return Buffer.from(value, "base64url").toString("utf8"); }
function signature(payload, key) { return createHmac("sha256", key).update(payload, "utf8").digest("base64url"); }
function keyBytes(key) { if (typeof key !== "string" || key.length < 16) throw new Error("receipt verification key is unavailable"); return key; }

/** Test-only envelope builder. Production/native code must own the signing key. */
export function createTestSignedReceiptEnvelope({ receipt, signingKey } = {}) {
  const payload = canonical(receipt);
  const key = keyBytes(signingKey);
  return Object.freeze({ version: RECEIPT_ENVELOPE_VERSION, payload: b64(payload), signature: signature(payload, key) });
}

/** Verify the opaque envelope without accepting caller approval booleans. */
export function verifySignedReceiptEnvelope(envelope, { verificationKey } = {}) {
  exactKeys(envelope, ENVELOPE_KEYS, "receipt envelope");
  if (envelope.version !== RECEIPT_ENVELOPE_VERSION || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error("receipt envelope malformed");
  const payload = unb64(envelope.payload);
  const expected = Buffer.from(signature(payload, keyBytes(verificationKey)), "base64url");
  const actual = Buffer.from(envelope.signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("receipt signature invalid");
  let receipt;
  try { receipt = JSON.parse(payload); } catch { throw new Error("receipt payload malformed"); }
  exactKeys(receipt, ["candidateCommit", "requestHash", "nonce", "issuedAtEpoch", "leaseSeconds", "expiresAtEpoch", "account", "profile", "operatorIdentity", "ownerIdentity", "testMode"], "receipt payload");
  if (!COMMIT.test(receipt.candidateCommit) || !HASH.test(receipt.requestHash) || !NONCE.test(receipt.nonce)) throw new Error("receipt binding malformed");
  if (receipt.testMode !== true || !Number.isSafeInteger(receipt.issuedAtEpoch) || !Number.isSafeInteger(receipt.leaseSeconds) || !Number.isSafeInteger(receipt.expiresAtEpoch)) throw new Error("receipt lease malformed");
  return Object.freeze(receipt);
}

function validateIdentity(identity) {
  exactKeys(identity, IDENTITY_KEYS, "identity");
  if (identity.account !== FROZEN_SPIKE_REQUEST.account || identity.profile !== FROZEN_SPIKE_REQUEST.profile || identity.testMode !== true) throw new Error("identity mismatch");
  return Object.freeze({ ...identity });
}
function trustedNtp(snapshot) {
  if (!snapshot || !Object.isFrozen(snapshot) || snapshot.authority !== CLOCK_AUTHORITY || !Object.isFrozen(snapshot.evidence)) throw new Error("untrusted NTP snapshot");
  parseSntpSample(snapshot.evidence); assertExecutionEpoch(snapshot.epoch);
  if (snapshot.evidence.nowEpoch !== snapshot.epoch || snapshot.capturedAtMs !== snapshot.epoch * 1000) throw new Error("NTP evidence is incomplete");
  return snapshot.epoch;
}
function redactedNativeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("native result malformed");
  const statusClass = result.statusClass ?? result.resultClass;
  if (!["success", "rejected", "timeout", "interrupted", "ambiguous", "unknown"].includes(statusClass)) throw new Error("native result class invalid");
  return Object.freeze({ statusClass, requestReference: typeof result.requestReference === "string" ? result.requestReference : null, objectClass: typeof result.objectClass === "string" ? result.objectClass : null, hasError: result.hasError === true });
}
function reject(_error) { const safe = new Error(SAFE_EXECUTION_FAILURE_MESSAGE); safe.cause = undefined; return safe; }

/**
 * JS-side half of the L-gate. It owns only frozen request/time/nonce admission.
 * Native authority owns verification, credential custody, and dispatch. The default
 * port is disabled and cannot be enabled by a caller boolean.
 */
export function createDisabledLiveAuthorityPort() {
  return Object.freeze({
    get enabled() { return false; },
    async dispatchOnce() { throw new Error(LIVE_AUTHORITY_DISABLED_MESSAGE); },
  });
}

export function createSplitProcessTrustOrchestrator({ candidateCommit, verificationKey, receiptSource, captureClock, nonceAdapter, readIdentity, leaseClock, nativeAuthority = createDisabledLiveAuthorityPort(), events = [] } = {}) {
  return Object.freeze({
    async execute() { throw new Error(LIVE_AUTHORITY_DISABLED_MESSAGE); },
  });
}
