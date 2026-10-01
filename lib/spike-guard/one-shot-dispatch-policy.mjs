const SAFE_FAILURE = "Dispatch stopped safely; no retry or second request is authorized.";
const TERMINAL_CLASSES = new Set(["success", "rejected", "timeout", "interrupted", "ambiguous", "unknown"]);

export const ONE_SHOT_POLICY_MESSAGE = SAFE_FAILURE;

export class OneShotDispatchPolicyError extends Error {
  constructor(code = "DISPATCH_ALREADY_CONSUMED") {
    super(SAFE_FAILURE);
    this.name = "OneShotDispatchPolicyError";
    this.code = code;
  }
}

function resultClass(result) {
  const candidate = result && typeof result === "object"
    ? (result.resultClass ?? result.statusClass)
    : undefined;
  return TERMINAL_CLASSES.has(candidate) ? candidate : "unknown";
}

/**
 * Consumes the local one-shot admission before entering the dispatch boundary.
 * A result or thrown error is terminal: this module has no retry, redirect,
 * fallback, resubmit, cleanup, or second-request capability by construction.
 */
export function createOneShotDispatchPolicy({ dispatch } = {}) {
  if (typeof dispatch !== "function") throw new TypeError("dispatch is required");
  let consumed = false;
  let calls = 0;

  return Object.freeze({
    get dispatchCount() { return calls; },
    async dispatchOnce(input) {
      if (consumed) throw new OneShotDispatchPolicyError();
      consumed = true;
      calls += 1;
      try {
        const firstResult = await dispatch(input);
        return Object.freeze({ status: "terminal", resultClass: resultClass(firstResult) });
      } catch {
        return Object.freeze({ status: "terminal", resultClass: "ambiguous" });
      }
    },
  });
}
