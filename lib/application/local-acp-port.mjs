import { createHash } from "node:crypto";

import {
  ACP_VERSION,
  RuntimeError,
  validateAcpPayload,
} from "../acp/runtime/index.mjs";

const REQUIRED_PERSISTENCE_METHODS = Object.freeze([
  "withTransaction",
  "claimAcpIdempotency",
  "storeAcpIdempotentResponse",
  "createAcpCheckout",
  "retrieveAcpCheckout",
  "updateAcpCheckout",
  "cancelAcpCheckout",
]);
const SESSION_ID = /^sess_[A-Za-z0-9_-]{6,120}$/;
const RUN_ID = /^run_[A-Za-z0-9_-]{6,120}$/;
const CHECKOUT_ID = /^(?:cs|csn)_[A-Za-z0-9_-]{6,120}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertPersistence(persistence) {
  if (!persistence || typeof persistence !== "object") throw new TypeError("persistence is required");
  const missing = REQUIRED_PERSISTENCE_METHODS.filter((name) => typeof persistence[name] !== "function");
  if (missing.length) throw new TypeError(`persistence is missing required methods: ${missing.join(", ")}`);
}

function assertContext(value) {
  if (!value || typeof value.subject !== "string" || value.subject.trim() === "") throw new RuntimeError("forbidden");
  if (!SESSION_ID.test(value.sessionId ?? "") || !RUN_ID.test(value.runId ?? "")) throw new RuntimeError("forbidden");
  return { subject: value.subject, sessionId: value.sessionId, runId: value.runId };
}

function assertMetadata({ apiVersion, requestId }) {
  if (apiVersion !== ACP_VERSION) throw new RuntimeError("unsupported_version");
  if (!REQUEST_ID.test(requestId ?? "")) throw new RuntimeError("invalid_request");
}

function assertCheckoutId(checkoutSessionId) {
  if (!CHECKOUT_ID.test(checkoutSessionId ?? "")) throw new RuntimeError("invalid_request");
}

function emptyPaymentHandlers(checkout) {
  if (!checkout || typeof checkout !== "object" || Array.isArray(checkout)) throw new RuntimeError("internal_error");
  const value = structuredClone(checkout);
  value.capabilities = {
    ...(value.capabilities ?? {}),
    payment: {
      ...(value.capabilities?.payment ?? {}),
      handlers: [],
    },
  };
  return value;
}

function checkedResponse(operation, checkout) {
  const value = emptyPaymentHandlers(checkout);
  if (!validateAcpPayload(operation, "response", value).valid) throw new RuntimeError("internal_error");
  return value;
}

function checkoutFromEnvelope(operation, result) {
  const success = {
    create: "created",
    update: "updated",
    cancel: "canceled",
  }[operation];
  if (result?.status === "not_found") throw new RuntimeError("not_found");
  if (result?.status === "forbidden") throw new RuntimeError("forbidden");
  if (result?.status !== success || !result.checkout) throw new RuntimeError("internal_error");
  return checkedResponse(operation, result.checkout);
}

function readCheckoutFromEnvelope(result) {
  if (result?.status === "not_found") throw new RuntimeError("not_found");
  if (result?.status === "forbidden") throw new RuntimeError("forbidden");
  if (result?.status !== "found" || !result.checkout) throw new RuntimeError("internal_error");
  return checkedResponse("retrieve", result.checkout);
}

function repositoryArguments(args, context) {
  return {
    subject: context.subject,
    sessionId: context.sessionId,
    runId: context.runId,
    requestId: args.requestId,
    apiVersion: ACP_VERSION,
  };
}

function idempotencyRecord({ context, scope, key, hash, response }) {
  return {
    subject: context.subject,
    sessionId: context.sessionId,
    runId: context.runId,
    scope,
    key,
    requestHash: hash,
    ...(response === undefined ? {} : { response }),
  };
}

function createMutation({ persistence, operation, method, needsCheckoutId = false }) {
  return async (args = {}) => {
    const context = assertContext(args.context);
    assertMetadata(args);
    if (needsCheckoutId) assertCheckoutId(args.checkoutSessionId);
    if (!IDEMPOTENCY_KEY.test(args.idempotencyKey ?? "")) throw new RuntimeError("idempotency_key_required");
    if (!args.input || typeof args.input !== "object" || Array.isArray(args.input)) throw new RuntimeError("invalid_request");

    const target = needsCheckoutId ? args.checkoutSessionId : "collection";
    const scope = `acp.checkout.${operation}:${target}`;
    const hash = requestHash({ operation, target, apiVersion: ACP_VERSION, input: args.input });

    try {
      return await persistence.withTransaction(async (tx) => {
        const claim = idempotencyRecord({ context, scope, key: args.idempotencyKey, hash });
        const claimed = await persistence.claimAcpIdempotency(tx, claim);
        if (claimed?.status === "conflict") throw new RuntimeError("idempotency_conflict");
        if (claimed?.status === "replay") {
          const value = checkedResponse(operation, claimed.response);
          return { value, idempotentReplayed: true };
        }
        if (claimed?.status !== "created") throw new RuntimeError("service_unavailable");

        const repositoryResult = await persistence[method](tx, {
          ...repositoryArguments(args, context),
          ...(needsCheckoutId ? { checkoutSessionId: args.checkoutSessionId } : {}),
          input: structuredClone(args.input),
        });
        const value = checkoutFromEnvelope(operation, repositoryResult);
        const stored = await persistence.storeAcpIdempotentResponse(
          tx,
          idempotencyRecord({ context, scope, key: args.idempotencyKey, hash, response: value }),
        );
        if (stored?.status !== "stored") throw new RuntimeError("service_unavailable");
        return { value, idempotentReplayed: false };
      });
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError("service_unavailable");
    }
  };
}

export function createLocalAcpApplicationPort({ persistence } = {}) {
  assertPersistence(persistence);

  const port = {
    createCheckout: createMutation({ persistence, operation: "create", method: "createAcpCheckout" }),
    async retrieveCheckout(args = {}) {
      const context = assertContext(args.context);
      assertMetadata(args);
      assertCheckoutId(args.checkoutSessionId);
      try {
        return await persistence.withTransaction(async (tx) => {
          const result = await persistence.retrieveAcpCheckout(tx, {
            ...repositoryArguments(args, context),
            checkoutSessionId: args.checkoutSessionId,
          });
          return { value: readCheckoutFromEnvelope(result) };
        });
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError("service_unavailable");
      }
    },
    updateCheckout: createMutation({ persistence, operation: "update", method: "updateAcpCheckout", needsCheckoutId: true }),
    cancelCheckout: createMutation({ persistence, operation: "cancel", method: "cancelAcpCheckout", needsCheckoutId: true }),
  };

  return Object.freeze(port);
}
