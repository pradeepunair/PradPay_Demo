const SAFE_FAILURE = "Secret dispatch boundary stopped safely; transport is disabled.";
const DISPATCH_RESULT_CLASSES = new Set(["success", "rejected", "timeout", "interrupted", "ambiguous", "unknown"]);

export const SECRET_DISPATCH_DISABLED_MESSAGE = SAFE_FAILURE;

export class SecretDispatchBoundaryError extends Error {
  constructor(code = "DISPATCH_DISABLED") {
    super(SAFE_FAILURE);
    this.name = "SecretDispatchBoundaryError";
    this.code = code;
  }
}

function safeResultClass(value) {
  const candidate = value && typeof value === "object" ? (value.resultClass ?? value.statusClass) : undefined;
  return DISPATCH_RESULT_CLASSES.has(candidate) ? candidate : "unknown";
}

function validateRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SecretDispatchBoundaryError("DISPATCH_INPUT_INVALID");
  }
  if (typeof input.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw new SecretDispatchBoundaryError("DISPATCH_INPUT_INVALID");
  }
  return Object.freeze({ requestHash: input.requestHash });
}

/**
 * Application-neutral boundary. The default is deliberately unusable. The only
 * enabled form is an explicitly test-only adapter with injected fakes; it has
 * no Keychain/credential lookup and never returns or records secret material.
 */
export function createSecretStoreDispatchAdapter({
  secretProvider,
  dispatch,
  enabled = false,
  testOnly = false,
} = {}) {
  const usable = enabled === true && testOnly === true
    && typeof secretProvider === "function" && typeof dispatch === "function";
  let consumed = false;

  return Object.freeze({
    get transportEnabled() { return false; },
    async dispatchOnce(input) {
      if (!usable) throw new SecretDispatchBoundaryError("DISPATCH_BOUNDARY_UNAVAILABLE");
      if (consumed) throw new SecretDispatchBoundaryError("DISPATCH_ALREADY_CONSUMED");
      const request = validateRequest(input);
      consumed = true;
      let secret;
      try {
        secret = await secretProvider(Object.freeze({ mode: "test", requestHash: request.requestHash }));
        if (typeof secret !== "string" || secret.length === 0) {
          throw new SecretDispatchBoundaryError("SECRET_UNAVAILABLE");
        }
        const result = await dispatch(Object.freeze({ request, secret }));
        return Object.freeze({ status: "dispatched", resultClass: safeResultClass(result) });
      } catch (error) {
        if (error instanceof SecretDispatchBoundaryError) throw error;
        throw new SecretDispatchBoundaryError("DISPATCH_FAILED");
      } finally {
        secret = undefined;
      }
    },
  });
}

export function redactSecretDispatchError() {
  return new Error(SAFE_FAILURE);
}
