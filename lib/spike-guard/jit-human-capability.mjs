import { createHash } from "node:crypto";
import { parseSntpSample } from "./clock.mjs";
import { canonicalBodyHash, canonicalRequestHash, buildJitRequest, FROZEN_SPIKE_REQUEST } from "./request.mjs";
import { CLOCK_AUTHORITY } from "./state.mjs";

const COMMIT = /^[a-f0-9]{40}$/;
const NONCE = /^[A-Za-z0-9_-]{16,256}$/;
const PHASE2_KEYS = ["candidateCommit", "account", "profile", "operatorIdentity", "ownerIdentity", "issuedAtEpoch", "expiresAtEpoch", "leaseSeconds", "requestHash", "canonicalBytesFingerprint", "bodyHash", "nonce", "paymentMethod", "endpoint", "stripeApiVersion", "acpVersion", "usageLimit", "requestCount", "paymentCount", "usdAmountMinor", "cleanup"];
const PHASE2_RESULT_KEYS = ["status", "receipt", "signature"];
export const JIT_CAPABILITY_ID = "M3-STRIPE-HUMAN-CAP-002";

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is required`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} fields are not exact`);
}
function trustedClock(snapshot) {
  if (!snapshot || !Object.isFrozen(snapshot) || snapshot.authority !== CLOCK_AUTHORITY || !Object.isFrozen(snapshot.evidence) || snapshot.evidence.nowEpoch !== snapshot.epoch) throw new Error("untrusted clock");
  parseSntpSample(snapshot.evidence);
  if (!Number.isSafeInteger(snapshot.epoch) || snapshot.epoch <= 0) throw new Error("clock epoch invalid");
  return snapshot.epoch;
}
function fingerprint(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function validateIdentity(identity) {
  exactKeys(identity, ["account", "profile", "operatorIdentity", "ownerIdentity", "testMode"], "identity");
  if (identity.account !== FROZEN_SPIKE_REQUEST.account || identity.profile !== FROZEN_SPIKE_REQUEST.profile || identity.testMode !== true) throw new Error("identity mismatch");
  return Object.freeze({ ...identity });
}

export function createJitNonceMemoryStore() {
  const consumed = new Map();
  return Object.freeze({ async consume(receipt) { const prior = consumed.get(receipt.nonce); if (prior) return { status: prior.requestHash === receipt.requestHash ? "duplicate" : "replay" }; consumed.set(receipt.nonce, Object.freeze({ requestHash: receipt.requestHash })); return { status: "consumed" }; } });
}
function assertPhase2Receipt(receipt, expected) {
  exactKeys(receipt, PHASE2_KEYS, "phase-2 receipt");
  for (const key of ["candidateCommit", "account", "profile", "operatorIdentity", "ownerIdentity", "paymentMethod", "endpoint", "stripeApiVersion", "acpVersion", "nonce", "requestHash", "canonicalBytesFingerprint", "bodyHash", "cleanup"]) if (receipt[key] !== expected[key]) throw new Error(`phase-2 receipt ${key} mismatch`);
  for (const key of ["issuedAtEpoch", "expiresAtEpoch", "leaseSeconds", "requestCount", "paymentCount", "usdAmountMinor"]) if (!Number.isSafeInteger(receipt[key])) throw new Error(`phase-2 receipt ${key} invalid`);
  if (receipt.expiresAtEpoch !== expected.expiresAtEpoch || receipt.leaseSeconds < 1 || receipt.leaseSeconds > 600 || receipt.requestCount !== 1 || receipt.paymentCount !== 0 || receipt.usdAmountMinor !== 0 || receipt.cleanup !== "not-authorized" || !NONCE.test(receipt.nonce)) throw new Error("phase-2 receipt scope invalid");
  return Object.freeze({ ...receipt });
}

// Local/fake-only approval artifact. It has no credential, nonce-consumption,
// provider, payment, network, or transport callback.
export function createLocalFakeTwoPhaseJitApproval({ candidateAuthority, readIdentity, captureClock, phase1Authentication, phase2Signing, leaseSeconds = 600, nonceFactory = () => "local_fake_nonce_123456" } = {}) {
  if (candidateAuthority?.kind !== "verified-local-git-head" || typeof candidateAuthority.read !== "function") throw new TypeError("independently verified local candidate authority is required");
  if (typeof readIdentity !== "function" || typeof captureClock !== "function" || typeof phase1Authentication !== "function" || typeof phase2Signing !== "function") throw new TypeError("two-phase fake adapters are required");
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 600) throw new TypeError("leaseSeconds must be between 1 and 600");
  return Object.freeze({ async approve() {
    const candidateCommit = await candidateAuthority.read();
    if (!COMMIT.test(candidateCommit)) throw new Error("trusted candidate provenance is invalid");
    const identity = validateIdentity(await readIdentity());
    const phase1Epoch = trustedClock(await captureClock());
    const intent = await phase1Authentication(Object.freeze({ phase: 1, kind: "biometric-intent", candidateCommit, identity, zeroPayment: true }));
    if (intent?.status !== "authenticated") throw new Error("phase 1 biometric intent cancelled");
    const lease = Object.freeze({ startsAtEpoch: phase1Epoch, endsAtEpoch: phase1Epoch + leaseSeconds, durationSeconds: leaseSeconds, nonExtendable: true });
    const requestResult = buildJitRequest({ candidateAuthority, trustedNtpEpoch: phase1Epoch, lease });
    if (requestResult.candidateCommit !== candidateCommit) throw new Error("candidate provenance changed before JIT construction");
    const canonicalBytes = Buffer.from(requestResult.canonicalBytes, "utf8");
    const nonce = nonceFactory();
    if (!NONCE.test(nonce)) throw new Error("local nonce is invalid");
    const receipt = Object.freeze({ candidateCommit, account: identity.account, profile: identity.profile, operatorIdentity: identity.operatorIdentity, ownerIdentity: identity.ownerIdentity, issuedAtEpoch: phase1Epoch, expiresAtEpoch: requestResult.expiresAtEpoch, leaseSeconds, requestHash: requestResult.requestHash, canonicalBytesFingerprint: fingerprint(requestResult.canonicalBytes), bodyHash: canonicalBodyHash(requestResult.request), nonce, paymentMethod: FROZEN_SPIKE_REQUEST.body.payment_method, endpoint: FROZEN_SPIKE_REQUEST.path, stripeApiVersion: FROZEN_SPIKE_REQUEST.stripeApiVersion, acpVersion: FROZEN_SPIKE_REQUEST.acpVersion, usageLimit: { currency: "usd", maxAmountMinor: 100 }, requestCount: 1, paymentCount: 0, usdAmountMinor: 0, cleanup: "not-authorized" });
    const phase2 = await phase2Signing(Object.freeze({ phase: 2, kind: "opaque-owner-key-receipt", receipt }));
    exactKeys(phase2, PHASE2_RESULT_KEYS, "phase-2 result");
    if (phase2.status !== "signed" || typeof phase2.signature !== "string") throw new Error("phase 2 signing cancelled or invalid");
    const signedReceipt = assertPhase2Receipt(phase2.receipt, receipt);
    const readbackBytes = Buffer.from(requestResult.canonicalBytes, "utf8");
    if (!readbackBytes.equals(canonicalBytes) || canonicalRequestHash(requestResult.request) !== requestResult.requestHash) throw new Error("immutable canonical bytes read-back mismatch");
    return Object.freeze({ status: "approved-locally", candidateCommit, expiresAtEpoch: requestResult.expiresAtEpoch, canonicalBytes: readbackBytes.toString("utf8"), requestHash: requestResult.requestHash, canonicalBytesFingerprint: fingerprint(readbackBytes.toString("utf8")), bodyHash: canonicalBodyHash(requestResult.request), signedReceipt, signature: phase2.signature });
  } });
}

// Historical effect-capable boundary retained only as an inert compatibility export.
export function createJitHumanCapabilityBoundary() {
  return Object.freeze({ async execute() { throw new Error("historical JIT execution boundary disabled; use local/fake two-phase approval"); } });
}
