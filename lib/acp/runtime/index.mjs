import { randomUUID, timingSafeEqual } from "node:crypto";

import checkoutSchema from "../../../protocol/acp/upstream/spec/2026-04-17/json-schema/schema.agentic_checkout.json" with { type: "json" };
import delegatePaymentSchema from "../../../protocol/acp/upstream/spec/2026-04-17/json-schema/schema.delegate_payment.json" with { type: "json" };
import { ACP_VERSION } from "../contract.mjs";
import { validateAgainstVendoredSchema } from "./schema-validator.mjs";

export { ACP_VERSION };

const ERROR_DEFINITIONS = Object.freeze({
  invalid_request: [400, "The request is invalid.", false],
  unsupported_version: [400, `API-Version must be ${ACP_VERSION}.`, false],
  unauthorized: [401, "Authentication is required.", false],
  forbidden: [403, "The authenticated context cannot access this run.", false],
  forbidden_origin: [403, "The request origin is not allowed.", false],
  capability_blocked: [403, "This capability is not enabled.", false],
  not_found: [404, "The requested checkout session was not found.", false],
  idempotency_key_required: [400, "Idempotency-Key is required for mutations.", false],
  idempotency_conflict: [422, "The idempotency key was used with a different request.", false],
  idempotency_in_flight: [409, "The original idempotent request is still processing.", true],
  service_unavailable: [503, "The service is temporarily unavailable.", true],
  internal_error: [500, "The request could not be processed.", false],
});

export class RuntimeError extends Error {
  constructor(code, options = {}) {
    const definition = ERROR_DEFINITIONS[code] ?? ERROR_DEFINITIONS.internal_error;
    super(definition[1], options);
    this.name = "RuntimeError";
    this.code = ERROR_DEFINITIONS[code] ? code : "internal_error";
    this.status = definition[0];
    this.retryable = definition[2];
  }
}

const OPERATIONS = Object.freeze({
  create: { mutation: true, request: "CheckoutSessionCreateRequest", response: "CheckoutSession", method: "createCheckout", status: 201 },
  retrieve: { mutation: false, response: "CheckoutSession", method: "retrieveCheckout", status: 200, needsCheckoutId: true },
  update: { mutation: true, request: "CheckoutSessionUpdateRequest", response: "CheckoutSession", method: "updateCheckout", status: 200, needsCheckoutId: true },
  complete: { mutation: true, request: "CheckoutSessionCompleteRequest", response: "CheckoutSessionWithOrder", method: "completeCheckout", status: 200, needsCheckoutId: true, flag: "complete" },
  cancel: { mutation: true, request: "CancelSessionRequest", response: "CheckoutSession", method: "cancelCheckout", status: 200, needsCheckoutId: true, optionalBody: true },
  "delegate-payment": { mutation: true, request: "DelegatePaymentRequest", response: "DelegatePaymentResponse", method: "delegatePayment", status: 201, schema: delegatePaymentSchema, flag: "delegatePayment" },
});

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_ID = /^sess_[A-Za-z0-9_-]{6,120}$/;
const RUN_ID = /^run_[A-Za-z0-9_-]{6,120}$/;
const CHECKOUT_ID = /^(?:cs|csn)_[A-Za-z0-9_-]{6,120}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;
const MAX_JSON_BODY_BYTES = 256 * 1024;

function safeRequestId(createRequestId) {
  try {
    const generated = createRequestId();
    if (typeof generated === "string" && SAFE_REQUEST_ID.test(generated)) return generated;
  } catch {
    // Fall through to the local generator so error responses still correlate.
  }
  return `req_${randomUUID()}`;
}

function responseHeaders(requestId, extra = {}) {
  return {
    "API-Version": ACP_VERSION,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Request-Id": requestId,
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

function errorResponse(error, requestId) {
  const safe = error instanceof RuntimeError ? error : new RuntimeError("internal_error");
  const extraHeaders = safe.code === "idempotency_in_flight" ? { "Retry-After": "1" } : {};
  return Response.json(
    { code: safe.code, message: safe.message, retryable: safe.retryable, requestId },
    { status: safe.status, headers: responseHeaders(requestId, extraHeaders) },
  );
}

function extractBearer(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s,]+)$/.exec(authorization);
  if (!match) throw new RuntimeError("unauthorized");
  return match[1];
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createServerHeldAuthenticator({ token, subject, sessionId, runIds }) {
  const safeRunIds = Array.isArray(runIds) ? [...runIds] : [];
  return async (presentedToken) => {
    if (!token || !constantTimeEqual(presentedToken, token)) return null;
    return { subject, sessionId, runIds: safeRunIds };
  };
}

function assertOrigin(request, allowedOrigins) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin === "null" || fetchSite === "cross-site" || (fetchSite && !origin)) throw new RuntimeError("forbidden_origin");
  if (origin && !allowedOrigins.includes(origin)) throw new RuntimeError("forbidden_origin");
}

function assertScopeHeaders(request) {
  const sessionId = request.headers.get("paymentlab-session-id") ?? "";
  const runId = request.headers.get("paymentlab-run-id") ?? "";
  if (!SESSION_ID.test(sessionId) || !RUN_ID.test(runId)) throw new RuntimeError("invalid_request");
  return { sessionId, runId };
}

function assertAuthorizedScope(identity, scope) {
  if (!identity || typeof identity.subject !== "string") throw new RuntimeError("unauthorized");
  const allowedRuns = Array.isArray(identity.runIds) ? identity.runIds : [];
  if (identity.sessionId !== scope.sessionId || !allowedRuns.includes(scope.runId)) throw new RuntimeError("forbidden");
}

async function readJson(request, optionalBody) {
  const contentType = request.headers.get("content-type") ?? "";
  if (optionalBody && request.body === null) return {};
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") throw new RuntimeError("invalid_request");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_JSON_BODY_BYTES)) {
    throw new RuntimeError("invalid_request");
  }

  const chunks = [];
  let size = 0;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new RuntimeError("invalid_request");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new RuntimeError("invalid_request");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (optionalBody && text.length === 0) return {};
    if (!text) throw new RuntimeError("invalid_request");
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError("invalid_request");
  }
}

function assertSchema(schema, definition, value, response = false) {
  const result = validateAgainstVendoredSchema(schema, definition, value);
  if (!result.valid) throw new RuntimeError(response ? "internal_error" : "invalid_request");
}

function validateOperationPayload(operation, direction, value) {
  const definition = OPERATIONS[operation];
  const schema = definition.schema ?? checkoutSchema;
  const schemaName = definition[direction];
  const result = validateAgainstVendoredSchema(schema, schemaName, value);
  if (direction === "request" && value && typeof value === "object" && !Array.isArray(value)) {
    const allowed = new Set(Object.keys(schema.$defs[schemaName].properties ?? {}));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) result.errors.push(`$.${key} is not supported`);
    }
    result.valid = result.errors.length === 0;
  }
  return result;
}

export function validateAcpPayload(operation, direction, value) {
  const definition = OPERATIONS[operation];
  if (!definition || !["request", "response"].includes(direction)) throw new TypeError("Unknown ACP operation or payload direction");
  const schemaName = definition[direction];
  if (!schemaName) throw new TypeError(`ACP ${operation} does not define a ${direction} body`);
  return validateOperationPayload(operation, direction, value);
}

function operationArguments({ operation, definition, context, checkoutSessionId, input, idempotencyKey, requestId }) {
  return {
    context,
    ...(definition.needsCheckoutId ? { checkoutSessionId } : {}),
    ...(definition.mutation ? { input, idempotencyKey } : {}),
    requestId,
    apiVersion: ACP_VERSION,
  };
}

function assertNoAdvertisedPaymentHandler(definition, value) {
  if (definition.schema === delegatePaymentSchema) return;
  const handlers = value?.capabilities?.payment?.handlers;
  if (Array.isArray(handlers) && handlers.length > 0) throw new RuntimeError("capability_blocked");
}

export function createAcpRuntimeHandler({
  port,
  authenticate,
  flags = {},
  allowedOrigins = [],
  createRequestId = () => `req_${randomUUID()}`,
}) {
  if (!port || typeof authenticate !== "function") throw new TypeError("ACP runtime requires an application port and authenticator");

  return async function handleAcpRuntimeRequest(request, { operation, checkoutSessionId } = {}) {
    const requestId = safeRequestId(createRequestId);
    try {
      const definition = OPERATIONS[operation];
      if (!definition) throw new RuntimeError("invalid_request");
      if (request.headers.get("api-version") !== ACP_VERSION) throw new RuntimeError("unsupported_version");
      assertOrigin(request, allowedOrigins);
      const scope = assertScopeHeaders(request);
      const identity = await authenticate(extractBearer(request), { request, ...scope });
      assertAuthorizedScope(identity, scope);
      if (flags.admission !== true) throw new RuntimeError("capability_blocked");
      if (definition.needsCheckoutId && !CHECKOUT_ID.test(checkoutSessionId ?? "")) throw new RuntimeError("invalid_request");

      let idempotencyKey;
      let input;
      if (definition.mutation) {
        idempotencyKey = request.headers.get("idempotency-key") ?? "";
        if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new RuntimeError("idempotency_key_required");
        input = await readJson(request, definition.optionalBody);
        if (!validateOperationPayload(operation, "request", input).valid) throw new RuntimeError("invalid_request");
      }

      // M2 deliberately has no executable payment capability. Validate the
      // pinned boundary, then block before an injected application port can run.
      if (definition.flag) throw new RuntimeError("capability_blocked");

      const method = port[definition.method];
      if (typeof method !== "function") throw new RuntimeError("service_unavailable");
      const result = await method(operationArguments({ operation, definition, context: { subject: identity.subject, ...scope }, checkoutSessionId, input, idempotencyKey, requestId }));
      if (!result || !("value" in result)) throw new RuntimeError("internal_error");
      assertSchema(definition.schema ?? checkoutSchema, definition.response, result.value, true);
      assertNoAdvertisedPaymentHandler(definition, result.value);
      const extraHeaders = definition.mutation
        ? {
            "Idempotency-Key": idempotencyKey,
            ...(result.idempotentReplayed === true ? { "Idempotent-Replayed": "true" } : {}),
          }
        : {};
      return Response.json(result.value, { status: definition.status, headers: responseHeaders(requestId, extraHeaders) });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}
