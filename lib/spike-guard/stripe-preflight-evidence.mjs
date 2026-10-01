const COMMIT = /^[a-f0-9]{40}$/;
const HASH_REF = /^sha256:[a-f0-9]{64}$/;
const STATUS = new Set(["UNVERIFIED", "BLOCKED", "SUPPORTED", "UNSUPPORTED", "AMBIGUOUS"]);
const EVIDENCE_KEYS = [
  "schemaVersion", "capability", "candidateCommit", "status", "mode", "accountRef", "apiVersion",
  "requestCount", "paymentCount", "usdAmountMinor", "secretStore", "dispatch", "observedAtEpoch", "blockers",
];

export const STRIPE_PREFLIGHT_SCHEMA_VERSION = "m3.read-only-stripe-capability-preflight.v1";
export const STRIPE_PREFLIGHT_CAPABILITY = "stripe-capability-preflight";

export class StripePreflightEvidenceError extends Error {
  constructor(code) {
    super("Stripe capability preflight evidence is invalid or redacted.");
    this.name = "StripePreflightEvidenceError";
    this.code = code;
  }
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StripePreflightEvidenceError(code);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new StripePreflightEvidenceError(code);
}

function nonnegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new StripePreflightEvidenceError(code);
}

/**
 * Validates documentary, read-only evidence only. This function performs no
 * provider call, vault read, transport setup, or dispatch; secret-bearing
 * fields are rejected rather than copied into the evidence record.
 */
export function createReadOnlyStripeCapabilityPreflightEvidence(input) {
  exactObject(input, EVIDENCE_KEYS, "EVIDENCE_FIELDS_INVALID");
  if (input.schemaVersion !== STRIPE_PREFLIGHT_SCHEMA_VERSION
    || input.capability !== STRIPE_PREFLIGHT_CAPABILITY
    || !COMMIT.test(input.candidateCommit)
    || !STATUS.has(input.status)
    || input.mode !== "test") throw new StripePreflightEvidenceError("EVIDENCE_IDENTITY_INVALID");
  if (!HASH_REF.test(input.accountRef) || typeof input.apiVersion !== "string" || input.apiVersion.length < 1) {
    throw new StripePreflightEvidenceError("EVIDENCE_REFERENCE_INVALID");
  }
  for (const [value, code] of [[input.requestCount, "REQUEST_COUNT_INVALID"], [input.paymentCount, "PAYMENT_COUNT_INVALID"], [input.usdAmountMinor, "AMOUNT_INVALID"], [input.observedAtEpoch, "TIME_INVALID"]]) nonnegativeInteger(value, code);
  exactObject(input.secretStore, ["configured", "metadataRead", "valueAccessed"], "SECRET_EVIDENCE_INVALID");
  if (typeof input.secretStore.configured !== "boolean" || typeof input.secretStore.metadataRead !== "boolean" || input.secretStore.valueAccessed !== false) throw new StripePreflightEvidenceError("SECRET_EVIDENCE_INVALID");
  exactObject(input.dispatch, ["attempted", "transport"], "DISPATCH_EVIDENCE_INVALID");
  if (input.dispatch.attempted !== false || input.dispatch.transport !== "disabled") throw new StripePreflightEvidenceError("DISPATCH_NOT_READ_ONLY");
  if (!Array.isArray(input.blockers) || input.blockers.some((value) => typeof value !== "string" || value.length === 0)) throw new StripePreflightEvidenceError("BLOCKERS_INVALID");
  return Object.freeze({
    ...input,
    secretStore: Object.freeze({ ...input.secretStore }),
    dispatch: Object.freeze({ ...input.dispatch }),
    blockers: Object.freeze([...input.blockers]),
  });
}
