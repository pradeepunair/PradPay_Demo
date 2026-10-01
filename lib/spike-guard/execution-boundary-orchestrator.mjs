import { createTestOnlyLocalAuthentication } from "./local-authentication.mjs";
import { FROZEN_REQUEST_HASH, FROZEN_SPIKE_REQUEST, assertExactSpikeRequest } from "./request.mjs";
import { CLOCK_AUTHORITY, MAX_ACTION_LEASE_SECONDS, createApprovalLease, assertActiveLease } from "./state.mjs";
import { assertExecutionEpoch, parseSntpSample } from "./clock.mjs";
import { sanitizeExecutionFailure } from "./safe-errors.mjs";

export const EXECUTION_CAPABILITY_ID = "M3-STRIPE-HUMAN-CAP-002";
export const KEYCHAIN_ITEM_NAME = "pradpay/stripe-test-helper";
const COMMIT = /^[a-f0-9]{40}$/;
const NONCE = /^[A-Za-z0-9_-]{16,256}$/;
const IDENTITY_KEYS = ["account", "profile", "operatorIdentity", "ownerIdentity", "testMode"];
const RECEIPT_KEYS = ["approvalId", "candidateCommit", "account", "profile", "operatorIdentity", "ownerIdentity", "issuedAtEpoch", "leaseSeconds", "expiresAtEpoch", "requestHash", "nonce", "testMode", "paymentMethod", "endpoint", "stripeApiVersion", "acpVersion", "usageLimit", "requestCount", "paymentCount", "usdAmountMinor", "cleanup"];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is required`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} fields are not exact`);
}

function validateIdentity(value, account) {
  exactKeys(value, IDENTITY_KEYS, "identity");
  if (value.account !== account || value.profile !== FROZEN_SPIKE_REQUEST.profile || value.testMode !== true) throw new Error("identity mismatch");
  for (const key of ["operatorIdentity", "ownerIdentity"]) if (typeof value[key] !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value[key])) throw new Error("identity label invalid");
  return Object.freeze({ ...value });
}

function trustedNtp(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Object.isFrozen(snapshot) || snapshot.authority !== CLOCK_AUTHORITY) throw new Error("untrusted NTP snapshot");
  if (!Object.isFrozen(snapshot.evidence) || snapshot.evidence.nowEpoch !== snapshot.epoch) throw new Error("NTP evidence is incomplete");
  parseSntpSample(snapshot.evidence);
  assertExecutionEpoch(snapshot.epoch);
  if (!Number.isSafeInteger(snapshot.capturedAtMs) || Math.floor(snapshot.capturedAtMs / 1000) !== snapshot.epoch) throw new Error("NTP capture is invalid");
  return snapshot.epoch;
}

function validateReceipt(receipt, identity, candidateCommit, nowEpoch) {
  exactKeys(receipt, RECEIPT_KEYS, "native receipt");
  if (receipt.approvalId !== EXECUTION_CAPABILITY_ID || receipt.candidateCommit !== candidateCommit) throw new Error("receipt candidate mismatch");
  for (const key of ["account", "profile", "operatorIdentity", "ownerIdentity"]) if (receipt[key] !== identity[key]) throw new Error("receipt identity mismatch");
  if (receipt.testMode !== true || receipt.requestHash !== FROZEN_REQUEST_HASH || !NONCE.test(receipt.nonce)) throw new Error("receipt binding invalid");
  if (receipt.paymentMethod !== FROZEN_SPIKE_REQUEST.body.payment_method || receipt.endpoint !== FROZEN_SPIKE_REQUEST.path || receipt.stripeApiVersion !== FROZEN_SPIKE_REQUEST.stripeApiVersion || receipt.acpVersion !== FROZEN_SPIKE_REQUEST.acpVersion || JSON.stringify(receipt.usageLimit) !== JSON.stringify({ currency: "usd", maxAmountMinor: 100 })) throw new Error("receipt request binding invalid");
  for (const [value, label] of [[receipt.issuedAtEpoch, "issuedAtEpoch"], [receipt.expiresAtEpoch, "expiresAtEpoch"], [receipt.leaseSeconds, "leaseSeconds"], [receipt.requestCount, "requestCount"], [receipt.paymentCount, "paymentCount"], [receipt.usdAmountMinor, "usdAmountMinor"]]) if (!Number.isSafeInteger(value)) throw new Error(`${label} invalid`);
  if (receipt.issuedAtEpoch !== nowEpoch || receipt.expiresAtEpoch !== nowEpoch + receipt.leaseSeconds || receipt.leaseSeconds < 1 || receipt.leaseSeconds > MAX_ACTION_LEASE_SECONDS) throw new Error("receipt time or lease is invalid");
  if (receipt.requestCount !== 1 || receipt.paymentCount !== 0 || receipt.usdAmountMinor !== 0 || receipt.cleanup !== "not-authorized") throw new Error("receipt effect scope invalid");
  return Object.freeze({ ...receipt });
}

function sameIdentity(actual, expected) {
  const validated = validateIdentity(actual, expected.account);
  for (const key of IDENTITY_KEYS) if (validated[key] !== expected[key]) throw new Error("final binding mismatch");
}

export function createDeterministicFakeNtp({ epoch, events = [] } = {}) {
  if (!Number.isSafeInteger(epoch)) throw new TypeError("fake NTP epoch is required");
  const output = ["selected:", "sntp_exchange {", "        result: 0 (Success)", "        offset: FFFFFFFFFFFFFFFF.E000000000000000 (-0.125000)", "}", "-0.125000 +/- 0.010000 time.apple.com 17.253.20.45"].join("\n");
  return Object.freeze({ async capture() { events.push("ntp"); return Object.freeze({ authority: CLOCK_AUTHORITY, epoch, capturedAtMs: epoch * 1000, evidence: Object.freeze({ command: Object.freeze(["sntp", "-d", "time.apple.com"]), output, exitCode: 0, observedAtEpoch: epoch, nowEpoch: epoch }) }); } });
}

export function createFakeHostedNonceAdapter({ events = [], consumed = new Map(), outcome = "consumed" } = {}) {
  return Object.freeze({ async consume(claim) { if (!claim || claim.requestHash !== FROZEN_REQUEST_HASH || !NONCE.test(claim.nonce)) throw new Error("nonce claim invalid"); if (consumed.has(claim.nonce)) throw new Error(consumed.get(claim.nonce) === claim.requestHash ? "nonce duplicate" : "nonce replay"); if (outcome !== "consumed") throw new Error(`nonce ${outcome}`); consumed.set(claim.nonce, claim.requestHash); return Object.freeze({ status: "consumed", nonce: claim.nonce, requestHash: claim.requestHash }); } });
}

export function createFakeKeychainSecretStore({ events = [], itemName = KEYCHAIN_ITEM_NAME, secret = "fake-test-secret", outcome = "available" } = {}) {
  return Object.freeze({
    get calls() { return events.filter((event) => event === "keychain").length; },
    async readSecret(input) {
      if (!input || input.itemName !== KEYCHAIN_ITEM_NAME || input.requestHash !== FROZEN_REQUEST_HASH) throw new Error("Keychain item mismatch");
      if (outcome !== "available") throw new Error(`Keychain ${outcome}`);
      return Object.freeze({ itemName, secret });
    },
  });
}

export function createFakeNativeDispatch({ events = [], secret = "fake-test-secret", dispatch = async () => ({ statusClass: "success", requestReference: null, objectClass: "other", objectReference: null, hasError: false }) } = {}) {
  let called = false;
  return Object.freeze({ get calls() { return called ? 1 : 0; }, async dispatchOnce(input) { if (called) throw new Error("dispatch already consumed"); called = true; if (typeof input?.secret !== "string" || input.secret !== secret) throw new Error("fake secret unavailable"); return dispatch(Object.freeze({ ...input })); } });
}

export function createExecutionBoundaryOrchestrator({ candidateCommit, expectedAccount = FROZEN_SPIKE_REQUEST.account, expectedIdentity = { account: expectedAccount, profile: FROZEN_SPIKE_REQUEST.profile, operatorIdentity: "operator.local", ownerIdentity: "owner.local", readOnly: true }, readIdentity, localAuthenticationProtocol, captureClock, nonceAdapter, secretStore, transport, dispatchAdapter, leaseClock, events = [] } = {}) {
  // This historical effect-capable entry point is intentionally inert. The
  // only executable JIT path is the separately named local/fake approval
  // boundary in jit-human-capability.mjs; no caller callback is inspected.
  return Object.freeze({
    async execute() { throw new Error("historical execution boundary disabled; use local/fake two-phase JIT approval"); },
  });
}
