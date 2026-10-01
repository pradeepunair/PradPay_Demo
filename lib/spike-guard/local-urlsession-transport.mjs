import { createHash } from "node:crypto";

import { FROZEN_REQUEST_HASH, FROZEN_SPIKE_REQUEST } from "./request.mjs";
import { createOneShotDispatchPolicy } from "./one-shot-dispatch-policy.mjs";

export const LOCAL_STRIPE_HOST = "api.stripe.com";
export const LOCAL_STRIPE_PATH = "/v1/test_helpers/shared_payment/granted_tokens";
export const LOCAL_STRIPE_API_VERSION = "2026-08-26.dahlia";
export const LOCAL_STRIPE_REQUEST_HASH = FROZEN_REQUEST_HASH;
export const LOCAL_TRANSPORT_TIMEOUT_MS = 50;
export const LOCAL_TRANSPORT_DISABLED_MESSAGE =
  "Automated Stripe transport is hard-disabled; use the test-only local URLSession fake.";

const FIXED_URL = `https://${LOCAL_STRIPE_HOST}${LOCAL_STRIPE_PATH}`;
const TERMINAL_RESULT = Object.freeze({ status: "terminal" });

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function own(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function redactedResult(resultClass, secret, responseStatus = undefined) {
  const result = {
    ...TERMINAL_RESULT,
    resultClass,
    requestHash: LOCAL_STRIPE_REQUEST_HASH,
    secretFingerprint: fingerprint(secret),
  };
  if (Number.isInteger(responseStatus)) result.responseStatus = responseStatus;
  return Object.freeze(result);
}

function requestForProtocol(secret, signal) {
  return Object.freeze({
    url: FIXED_URL,
    host: LOCAL_STRIPE_HOST,
    path: LOCAL_STRIPE_PATH,
    method: "POST",
    apiVersion: LOCAL_STRIPE_API_VERSION,
    requestHash: LOCAL_STRIPE_REQUEST_HASH,
    signal,
    headers: Object.freeze({
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": LOCAL_STRIPE_API_VERSION,
    }),
    // The fake receives the credential only to model the native request. It is
    // never copied into a result, error, log, or evidence record.
    body: Object.freeze({
      payment_method: FROZEN_SPIKE_REQUEST.body.payment_method,
      usage_limits: Object.freeze({ ...FROZEN_SPIKE_REQUEST.body.usage_limits }),
      secret,
    }),
  });
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("local transport input is invalid");
  if (typeof input.secret !== "string" || input.secret.length === 0) throw new TypeError("local transport secret is invalid");
  if (own(input, "url") || own(input, "body")) throw new TypeError("caller URL/body are not accepted");
}

/**
 * Test-only URLSession/URLProtocol-shaped boundary. It constructs the exact
 * approved request and accepts only an injected local fake; it has no network
 * primitive and never follows redirects or retries.
 */
export function createTestOnlyLocalStripeTransport({ urlProtocol, timeoutMs = LOCAL_TRANSPORT_TIMEOUT_MS, testOnly = false } = {}) {
  if (testOnly !== true || typeof urlProtocol !== "function") throw new TypeError("test-only local URLProtocol is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeout must be a positive integer");

  const policy = createOneShotDispatchPolicy({
    dispatch: async ({ secret }) => {
      const controller = new AbortController();
      const request = requestForProtocol(secret, controller.signal);
      let timer;
      let settled = false;
      const fakeResult = Promise.resolve().then(() => urlProtocol(request));
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          settled = true;
          controller.abort();
          resolve({ resultClass: "timeout" });
        }, timeoutMs);
      });
      const response = await Promise.race([fakeResult, timeout]);
      if (timer) clearTimeout(timer);
      if (settled) return response;
      if (!response || typeof response !== "object") return { resultClass: "ambiguous" };
      if (response.type === "redirect") return { resultClass: "rejected", responseStatus: 3_00 };
      if (response.type === "timeout") return { resultClass: "timeout" };
      if (response.type !== "response" || !Number.isInteger(response.status)) return { resultClass: "ambiguous" };
      return {
        resultClass: response.status >= 200 && response.status < 300 ? "success" : "rejected",
        responseStatus: response.status,
      };
    },
  });

  return Object.freeze({
    get dispatchCount() { return policy.dispatchCount; },
    async dispatchOnce(input) {
      validateInput(input);
      const result = await policy.dispatchOnce({ secret: input.secret });
      return redactedResult(result.resultClass, input.secret, result.responseStatus);
    },
  });
}

/** No automated/provider transport is exported or enabled. */
export function createAutomatedStripeTransport() {
  return async function automatedStripeTransport() {
    throw new Error(LOCAL_TRANSPORT_DISABLED_MESSAGE);
  };
}
