function validateUnknownOperation(operation) {
  if (operation?.status !== "unknown" || !operation.operationId || !operation.attemptId) {
    throw new TypeError("Reconciliation requires an unknown operation with an existing attempt.");
  }
  if (!operation.sessionId || !operation.runId) {
    throw new TypeError("Reconciliation requires sessionId and runId ownership scope.");
  }
}

export function planUnknownOutcomeReconciliation(operation) {
  validateUnknownOperation(operation);
  return Object.freeze({
    action: "reconcile_existing_attempt",
    operationId: operation.operationId,
    attemptId: operation.attemptId,
    holdAuthority: true,
    createReplacementAttempt: false,
  });
}

export async function scheduleUnknownOutcomeReconciliation({ persistence, operation }) {
  validateUnknownOperation(operation);
  if (typeof persistence?.withTransaction !== "function"
    || typeof persistence?.createOutboxJob !== "function") {
    throw new TypeError("Reconciliation requires the transactional outbox persistence port.");
  }
  return persistence.withTransaction((tx) => persistence.createOutboxJob(tx, {
    type: "payment.reconcile_unknown",
    dedupeKey: `reconcile:${operation.attemptId}`,
    sessionId: operation.sessionId,
    runId: operation.runId,
    safePayload: {
      operationId: operation.operationId,
      attemptId: operation.attemptId,
      sessionId: operation.sessionId,
      runId: operation.runId,
    },
  }));
}

function validateScope(scope) {
  for (const field of ["sessionId", "runId", "attemptId"]) {
    if (typeof scope?.[field] !== "string" || scope[field].length === 0) {
      throw new TypeError(`Reconciliation requires ${field}.`);
    }
  }
}

function verifiedControl(control, scope) {
  const sessionId = control?.sessionId ?? control?.session_id;
  const runId = control?.runId ?? control?.run_id;
  const attemptId = control?.attemptId ?? control?.attempt_id;
  return control?.state === "pending"
    && sessionId === scope.sessionId
    && runId === scope.runId
    && attemptId === scope.attemptId;
}

function verifiedUnknownAttempt(attempt, scope, operationId = undefined) {
  const sessionId = attempt?.sessionId ?? attempt?.session_id;
  const runId = attempt?.runId ?? attempt?.run_id;
  const attemptId = attempt?.attemptId ?? attempt?.attempt_id ?? attempt?.id;
  const durableOperationId = attempt?.operationId ?? attempt?.operation_id
    ?? attempt?.operationKey ?? attempt?.operation_key;
  return attempt?.state === "unknown"
    && sessionId === scope.sessionId
    && runId === scope.runId
    && attemptId === scope.attemptId
    && (operationId === undefined || durableOperationId === operationId);
}

function verifiedMarkedUnknownAttempt(result, scope, operationId) {
  return result?.status === "updated"
    && verifiedUnknownAttempt(result.attempt, scope, operationId);
}

function reconciliationJob(scope, operationId = undefined) {
  return {
    type: "payment.reconcile_unknown",
    dedupeKey: `reconcile:${scope.attemptId}`,
    sessionId: scope.sessionId,
    runId: scope.runId,
    safePayload: {
      ...(operationId ? { operationId } : {}),
      attemptId: scope.attemptId,
      sessionId: scope.sessionId,
      runId: scope.runId,
    },
  };
}

export async function recordAndScheduleUnknownOutcome({ persistence, operation }) {
  validateUnknownOperation(operation);
  for (const method of [
    "withTransaction",
    "markPaymentAttemptUnknown",
    "upsertReconciliationControl",
    "createOutboxJob",
  ]) {
    if (typeof persistence?.[method] !== "function") {
      throw new TypeError(`Unknown-outcome recording requires persistence.${method}.`);
    }
  }
  const scope = {
    sessionId: operation.sessionId,
    runId: operation.runId,
    attemptId: operation.attemptId,
  };
  return persistence.withTransaction(async (tx) => {
    const attempt = await persistence.markPaymentAttemptUnknown(tx, {
      ...scope,
      operationId: operation.operationId,
    });
    if (!verifiedMarkedUnknownAttempt(attempt, scope, operation.operationId)) {
      throw new Error("Persistence did not mark and verify the durable payment attempt as unknown.");
    }
    const control = await persistence.upsertReconciliationControl(tx, {
      id: `reconciliation_${scope.attemptId}`,
      ...scope,
      resultCode: "synthetic_unknown",
    });
    if (!verifiedControl(control, scope)) {
      throw new Error("Persistence did not verify the durable unknown attempt.");
    }
    return persistence.createOutboxJob(tx, reconciliationJob(scope, operation.operationId));
  });
}

export async function scheduleDurablyVerifiedReconciliation({ persistence, scope }) {
  validateScope(scope);
  for (const method of [
    "withTransaction",
    "readUnknownPaymentAttempt",
    "readReconciliationControl",
    "createOutboxJob",
  ]) {
    if (typeof persistence?.[method] !== "function") {
      throw new TypeError(`Existing-attempt reconciliation requires persistence.${method}.`);
    }
  }
  return persistence.withTransaction(async (tx) => {
    const attempt = await persistence.readUnknownPaymentAttempt(tx, scope);
    const control = await persistence.readReconciliationControl(tx, scope);
    if (!verifiedUnknownAttempt(attempt, scope) || !verifiedControl(control, scope)) {
      throw new Error("No durable unknown attempt is eligible for reconciliation.");
    }
    return persistence.createOutboxJob(tx, reconciliationJob(scope));
  });
}
