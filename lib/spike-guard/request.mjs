import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { assertNonExtendableJitLease, assertTrustedJitEpoch } from "./clock.mjs";

const COMMIT = /^[a-f0-9]{40}$/;


const ACCOUNT = "acct_demofixture0001";
const PAYMENT_METHOD = "pm_demo_fixture_0001";
const ENDPOINT = "/v1/test_helpers/shared_payment/granted_tokens";
const STRIPE_API = "2026-08-26.dahlia";
const ACP = "2026-04-17";

function deepFreeze(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("request contains a non-plain object");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) throw new TypeError("request contains a non-canonical key");
    const result = {};
    for (const key of keys.sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("request contains a non-finite number");
    return value;
  }
  if (["string", "boolean"].includes(typeof value) || value === null) return value;
  throw new TypeError("request contains a non-canonical value");
}

function bytesFor(request) {
  return JSON.stringify(canonicalize(request));
}

// `canonicalBodyHash` is a fixture/body-only digest. It must never be used as
// the full wire/approval-envelope digest (`canonicalRequestHash`).
export function canonicalBodyBytes(request) {
  return Buffer.from(bytesFor(request.body), "utf8");
}

export function canonicalBodyHash(request) {
  return createHash("sha256").update(canonicalBodyBytes(request)).digest("hex");
}

// Full frozen request/envelope bytes, including candidate and all bindings.
export function canonicalRequestBytes(request) {
  return Buffer.from(bytesFor(request), "utf8");
}

export function canonicalRequestHash(request) {
  return createHash("sha256").update(canonicalRequestBytes(request)).digest("hex");
}

// Local-only provenance adapter. It reads executable Git's HEAD; it does not
export function createVerifiedLocalGitHeadAuthority({ repositoryPath } = {}) {
  if (typeof repositoryPath !== "string" || !repositoryPath) throw new TypeError("repositoryPath is required");
  return Object.freeze({
    kind: "verified-local-git-head",
    read() {
      const actual = execFileSync("git", ["-C", repositoryPath, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
      if (!COMMIT.test(actual) || /^0{40}$/.test(actual)) throw new Error("local Git HEAD provenance is invalid");
      return actual;
    },
  });
}

// Shape-only frozen fixture. Its null expiry is deliberately not executable; JIT builders supply a fresh epoch.
export const FROZEN_SPIKE_REQUEST = deepFreeze({
  account: ACCOUNT,
  profile: "PradPay sandbox",
  method: "POST",
  path: ENDPOINT,
  stripeApiVersion: STRIPE_API,
  acpVersion: ACP,
  capability: "shared_payment_granted_token_test_helper",
  body: { payment_method: PAYMENT_METHOD, usage_limits: { currency: "usd", max_amount: 100, expires_at: null } },
  effects: { paymentCount: 0, usdAmountMinor: 0 },
  transport: { maxAttempts: 1, retry: false, followRedirects: false, fallback: false, resubmit: false },
});

export const FROZEN_REQUEST_HASH = canonicalRequestHash(FROZEN_SPIKE_REQUEST);
export const APPROVED_REQUEST_HASH = FROZEN_REQUEST_HASH;

function exactRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new TypeError("spike request must be an object");
  if (request.account !== ACCOUNT || request.body?.payment_method !== PAYMENT_METHOD || request.path !== ENDPOINT || request.method !== "POST" || request.stripeApiVersion !== STRIPE_API || request.acpVersion !== ACP) throw new Error("request binding mismatch");
  if (request.body?.usage_limits?.currency !== "usd" || request.body.usage_limits.max_amount !== 100 || request.effects?.paymentCount !== 0 || request.effects?.usdAmountMinor !== 0) throw new Error("request effect scope mismatch");
  if (request.transport?.maxAttempts !== 1 || request.transport.retry || request.transport.followRedirects || request.transport.fallback || request.transport.resubmit) throw new Error("request transport scope mismatch");
  return request;
}

function readTrustedCandidate(candidateAuthority) {
  if (candidateAuthority?.kind !== "verified-local-git-head" || typeof candidateAuthority.read !== "function") throw new Error("independently verified local candidate authority is required");
  const candidateCommit = candidateAuthority.read();
  if (!COMMIT.test(candidateCommit) || /^0{40}$/.test(candidateCommit)) throw new Error("candidate commit is invalid");
  return candidateCommit;
}

export function buildJitRequest({ candidateAuthority, trustedNtpEpoch, lease } = {}) {
  const candidateCommit = readTrustedCandidate(candidateAuthority);
  const now = assertTrustedJitEpoch(trustedNtpEpoch);
  assertNonExtendableJitLease(lease, now);
  const expiresAt = lease.endsAtEpoch;
  const request = deepFreeze({ ...structuredClone(FROZEN_SPIKE_REQUEST), candidateCommit, body: { ...structuredClone(FROZEN_SPIKE_REQUEST.body), usage_limits: { currency: "usd", max_amount: 100, expires_at: expiresAt } } });
  exactRequest(request);
  const canonicalBytes = canonicalRequestBytes(request);
  const requestHash = createHash("sha256").update(canonicalBytes).digest("hex");
  // Expose immutable UTF-8 bytes as a string; mutable Buffer instances must
  // remain inside the guarded builder/read-back boundary.
  const result = deepFreeze({ request, candidateCommit, trustedNtpEpoch: now, lease, expiresAtEpoch: expiresAt, canonicalBytes: canonicalBytes.toString("utf8"), requestHash });
  assertJitRequestReadback(result, { candidateAuthority });
  return result;
}

export const createJitRequest = buildJitRequest;
export const createFreshJitRequest = buildJitRequest;

export function assertJitRequestReadback(result, { candidateAuthority } = {}) {
  if (!result || typeof result !== "object" || !Object.isFrozen(result)) throw new Error("JIT request read-back is not frozen");
  if (result.candidateCommit !== readTrustedCandidate(candidateAuthority)) throw new Error("JIT candidate provenance changed");
  const now = assertTrustedJitEpoch(result.trustedNtpEpoch);
  assertNonExtendableJitLease(result.lease, now);
  if (result.expiresAtEpoch !== result.lease.endsAtEpoch || result.expiresAtEpoch <= now || result.request.body.usage_limits.expires_at !== result.expiresAtEpoch) throw new Error("JIT expiry is stale or inconsistent");
  exactRequest(result.request);
  const bytes = canonicalRequestBytes(result.request);
  if (typeof result.canonicalBytes !== "string" || !bytes.equals(Buffer.from(result.canonicalBytes, "utf8"))) throw new Error("JIT canonical bytes mismatch");
  if (result.requestHash !== canonicalRequestHash(result.request)) throw new Error("JIT request hash mismatch");
  return result;
}

export function assertExactSpikeRequest(request) {
  if (canonicalRequestHash(request) !== FROZEN_REQUEST_HASH) throw new Error("spike request does not match the frozen shape");
  return FROZEN_SPIKE_REQUEST;
}

// The null-expiry fixture is shape-only test data and can never authorize a
// credential/provider boundary. Runtime callers must use buildJitRequest and
// assertJitRequestReadback with a fresh lease-generated expiry.
export function assertFrozenRequestIsNotDispatchable(request, requestHash = FROZEN_REQUEST_HASH) {
  if (requestHash === FROZEN_REQUEST_HASH || request?.body?.usage_limits?.expires_at === null) {
    throw new Error("shape-only request cannot authorize dispatch");
  }
  return request;
}
