const scenarios = new Set([
  "succeeded",
  "declined",
  "requires_action",
  "timeout_before_effect",
  "timeout_after_effect",
  "callback_before_response",
  "duplicate_callback",
]);

const statusByScenario = Object.freeze({
  succeeded: "succeeded",
  declined: "declined",
  requires_action: "requires_action",
  timeout_after_effect: "succeeded",
  callback_before_response: "succeeded",
  duplicate_callback: "succeeded",
});

export class SyntheticProviderTimeoutError extends Error {
  constructor({ effectRecorded, effectId = null, safeEvent = null }) {
    super("Synthetic provider outcome is unknown.");
    this.name = "SyntheticProviderTimeoutError";
    this.code = "SYNTHETIC_TIMEOUT";
    this.retryable = true;
    this.outcome = "unknown";
    this.effectRecorded = effectRecorded;
    this.effectId = effectId;
    this.safeEvent = safeEvent;
  }
}

async function deliverCallbackOrUnknown(onCallback, event, record) {
  try {
    await onCallback(event);
  } catch {
    throw new SyntheticProviderTimeoutError({
      effectRecorded: true,
      effectId: record.effectId,
      safeEvent: record.safeEvent,
    });
  }
}

export class SyntheticIdempotencyConflictError extends Error {
  constructor() {
    super("Synthetic idempotency key was reused with different parameters.");
    this.name = "SyntheticIdempotencyConflictError";
    this.code = "SYNTHETIC_IDEMPOTENCY_CONFLICT";
    this.retryable = false;
  }
}

function validateIdentity(identity) {
  for (const field of ["operationId", "attemptId", "idempotencyKey"]) {
    if (typeof identity?.[field] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(identity[field])) {
      throw new TypeError(`Synthetic provider requires a stable opaque ${field}.`);
    }
  }
  if (typeof identity.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(identity.requestHash)) {
    throw new TypeError("Synthetic provider requires a lowercase SHA-256 requestHash.");
  }
}

function sameIdentity(record, identity) {
  return record.operationId === identity.operationId
    && record.attemptId === identity.attemptId
    && record.idempotencyKey === identity.idempotencyKey
    && record.requestHash === identity.requestHash;
}

function makeRecord(scenario, identity) {
  const hasEffect = scenario !== "timeout_before_effect";
  const status = statusByScenario[scenario] ?? "unknown";
  const effectId = hasEffect ? `synthetic_effect_${identity.attemptId}` : null;
  const safeEvent = hasEffect ? Object.freeze({
    provider: "synthetic",
    providerEventId: `synthetic_event_${identity.attemptId}`,
    type: `synthetic_payment.${status}`,
    providerCreatedAt: 1_788_921_000,
    objectId: `synthetic_payment_${identity.attemptId}`,
    operationId: identity.operationId,
    attemptId: identity.attemptId,
    livemode: false,
  }) : null;
  return {
    ...identity,
    scenario,
    status,
    effectId,
    safeEvent,
    hasEffect,
  };
}

function result(record, replay) {
  return Object.freeze({
    scenario: record.scenario,
    status: record.status,
    outcome: "known",
    replay,
    operationId: record.operationId,
    attemptId: record.attemptId,
    effectId: record.effectId,
    safeEvent: record.safeEvent,
  });
}

export function createSyntheticPaymentProvider({ scenario }) {
  if (!scenarios.has(scenario)) throw new TypeError(`Unsupported synthetic scenario: ${scenario}`);
  const byOperation = new Map();
  const byAttempt = new Map();
  const byIdempotency = new Map();
  let operationCount = 0;
  let calls = 0;
  let effects = 0;

  return Object.freeze({
    async execute(identity, { onCallback = () => {} } = {}) {
      validateIdentity(identity);
      if (typeof onCallback !== "function") throw new TypeError("onCallback must be a function.");
      calls += 1;
      const candidates = [
        byOperation.get(identity.operationId),
        byAttempt.get(identity.attemptId),
        byIdempotency.get(identity.idempotencyKey),
      ].filter(Boolean);
      const existing = candidates[0];
      if (candidates.some((candidate) => candidate !== existing)
        || (existing && !sameIdentity(existing, identity))) {
        throw new SyntheticIdempotencyConflictError();
      }
      const replay = Boolean(existing);
      const record = existing ?? makeRecord(scenario, identity);
      if (!existing) {
        byOperation.set(identity.operationId, record);
        byAttempt.set(identity.attemptId, record);
        byIdempotency.set(identity.idempotencyKey, record);
        operationCount += 1;
        if (record.hasEffect) effects += 1;
      }

      if (scenario === "timeout_before_effect") {
        throw new SyntheticProviderTimeoutError({ effectRecorded: false });
      }
      if (scenario === "timeout_after_effect") {
        await deliverCallbackOrUnknown(onCallback, record.safeEvent, record);
        throw new SyntheticProviderTimeoutError({
          effectRecorded: true,
          effectId: record.effectId,
          safeEvent: record.safeEvent,
        });
      }
      if (scenario === "callback_before_response") {
        await deliverCallbackOrUnknown(onCallback, record.safeEvent, record);
      }
      if (scenario === "duplicate_callback") {
        await deliverCallbackOrUnknown(onCallback, record.safeEvent, record);
        await deliverCallbackOrUnknown(onCallback, record.safeEvent, record);
      }
      return result(record, replay);
    },

    inspect() {
      return Object.freeze({ calls, effects, operations: operationCount });
    },
  });
}

const eventStatus = Object.freeze({
  "synthetic_payment.succeeded": "succeeded",
  "synthetic_payment.declined": "declined",
  "synthetic_payment.requires_action": "requires_action",
});
const terminal = new Set(["succeeded", "declined"]);

export function reduceSyntheticPaymentEvent({ current, event }) {
  const nextStatus = eventStatus[event?.type];
  if (!nextStatus) return { disposition: "ignored_type", state: current };
  if (current && (event.operationId !== current.operationId || event.attemptId !== current.attemptId)) {
    return { disposition: "ignored_identity_mismatch", state: current };
  }
  if (current?.providerEventId === event.providerEventId) {
    return { disposition: "duplicate", state: current };
  }
  if (current && event.providerCreatedAt < current.providerCreatedAt) {
    return { disposition: "ignored_stale", state: current };
  }
  if (current && event.providerCreatedAt === current.providerCreatedAt) {
    return { disposition: "ignored_ambiguous_order", state: current };
  }
  if (current && terminal.has(current.status) && nextStatus !== current.status) {
    return { disposition: "ignored_terminal", state: current };
  }
  return {
    disposition: "applied",
    state: Object.freeze({
      status: nextStatus,
      providerEventId: event.providerEventId,
      providerCreatedAt: event.providerCreatedAt,
      operationId: event.operationId,
      attemptId: event.attemptId,
    }),
  };
}
