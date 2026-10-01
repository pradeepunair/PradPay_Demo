const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export const NONCE_REJECTION_CODES = Object.freeze({
  DUPLICATE: "NONCE_DUPLICATE",
  REPLAY: "NONCE_REPLAY",
  STORE_UNAVAILABLE: "NONCE_STORE_UNAVAILABLE",
  TRANSACTION_AMBIGUOUS: "NONCE_TRANSACTION_AMBIGUOUS",
});

export class NonceConsumptionRejection extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = "NonceConsumptionRejection";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function requireMethod(value, method) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`nonce store requires ${method}()`);
  }
}

function requireInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("nonce consumption input is required");
  }
  const keys = Object.keys(input).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["expiresAtEpoch", "nonce", "requestHash"])) {
    throw new TypeError("nonce consumption input fields do not match the local contract");
  }
  if (typeof input.nonce !== "string" || !NONCE_PATTERN.test(input.nonce)) {
    throw new TypeError("nonce must be a 16-256 character URL-safe token");
  }
  if (typeof input.requestHash !== "string" || !HASH_PATTERN.test(input.requestHash)) {
    throw new TypeError("requestHash must be a lowercase SHA-256 hex digest");
  }
  if (!Number.isSafeInteger(input.expiresAtEpoch) || input.expiresAtEpoch <= 0) {
    throw new TypeError("expiresAtEpoch must be a positive safe integer");
  }
  return Object.freeze({ ...input });
}

function classifyStoreFailure(error) {
  const code = error?.code;
  if (code === "DB_UNAVAILABLE" || code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return new NonceConsumptionRejection(
      NONCE_REJECTION_CODES.STORE_UNAVAILABLE,
      "nonce consumption store is unavailable",
      { cause: error },
    );
  }
  if (code === "TRANSACTION_AMBIGUOUS" || code === "TX_COMMIT_UNKNOWN") {
    return new NonceConsumptionRejection(
      NONCE_REJECTION_CODES.TRANSACTION_AMBIGUOUS,
      "nonce transaction outcome is ambiguous",
      { cause: error },
    );
  }
  return error;
}

function rejectionForStatus(status) {
  if (status === "duplicate") {
    return new NonceConsumptionRejection(NONCE_REJECTION_CODES.DUPLICATE, "nonce has already been consumed");
  }
  if (status === "replay") {
    return new NonceConsumptionRejection(NONCE_REJECTION_CODES.REPLAY, "nonce replay does not match the original request");
  }
  throw new Error("nonce store returned an invalid consumption outcome");
}

/**
 * Local-only port. The store must atomically insert the nonce inside the
 * supplied transaction and return consumed, duplicate, or replay. No network,
 * credential, or provider adapter is accepted by this contract.
 */
export function createNonceConsumptionAdapter({ store } = {}) {
  requireMethod(store, "withTransaction");
  const consumeMethod = typeof store.consumeJitNonce === "function" ? "consumeJitNonce" : "consumeNonce";
  requireMethod(store, consumeMethod);

  const consume = async (input) => {
    const claim = requireInput(input);
    let result;
    try {
      result = await store.withTransaction((tx) => store[consumeMethod](tx, claim));
    } catch (error) {
      throw classifyStoreFailure(error);
    }
    if (result?.status !== "consumed") {
      throw rejectionForStatus(result?.status);
    }
    return Object.freeze({
      status: "consumed",
      nonce: claim.nonce,
      requestHash: claim.requestHash,
      expiresAtEpoch: claim.expiresAtEpoch,
    });
  };

  const admit = async ({ claim, onConsumed } = {}) => {
    if (typeof onConsumed !== "function") throw new TypeError("onConsumed callback is required");
    const receipt = await consume(claim);
    return onConsumed(receipt);
  };

  return Object.freeze({ consume, admit });
}
