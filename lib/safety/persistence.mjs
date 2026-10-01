function requireMethod(value, method, owner) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`${owner} must implement ${method}().`);
  }
}

function rejectedAttemptClaim() {
  return Object.freeze({ status: "rejected" });
}

function normalizeAttemptClaim(result, scope) {
  if (result?.status === "rejected" && Object.keys(result).length === 1) {
    return rejectedAttemptClaim();
  }
  if (!result || result.status !== "ready" || Object.keys(result).length !== 2
    || !result.attempt || typeof result.attempt !== "object" || Array.isArray(result.attempt)) {
    return rejectedAttemptClaim();
  }
  const attempt = result.attempt;
  if (attempt.session_id !== scope.sessionId
    || attempt.run_id !== scope.runId
    || attempt.id !== scope.attemptId
    || attempt.operation_key !== scope.operationId
    || attempt.request_hash !== scope.requestHash
    || attempt.state !== "submitted") {
    return rejectedAttemptClaim();
  }
  return Object.freeze({
    status: "ready",
    attempt: Object.freeze({
      id: attempt.id,
      sessionId: attempt.session_id,
      runId: attempt.run_id,
      attemptId: attempt.id,
      operationId: attempt.operation_key,
      requestHash: attempt.request_hash,
      state: attempt.state,
    }),
  });
}

export function createLocalSafetyPersistence({ dataPersistence, outboxPersistence } = {}) {
  for (const method of [
    "withTransaction",
    "readSafetyControl",
    "reserveSyntheticBudget",
    "claimSyntheticPaymentAttempt",
    "markPaymentAttemptUnknown",
    "readUnknownPaymentAttempt",
    "upsertReconciliationControl",
    "readReconciliationControl",
    "createOutboxJob",
  ]) {
    requireMethod(dataPersistence, method, "dataPersistence");
  }
  requireMethod(outboxPersistence, "createOutboxJob", "outboxPersistence");

  return Object.freeze({
    withTransaction: dataPersistence.withTransaction.bind(dataPersistence),
    readSafetyControl: dataPersistence.readSafetyControl.bind(dataPersistence),
    reserveSyntheticBudget: dataPersistence.reserveSyntheticBudget.bind(dataPersistence),
    async claimSyntheticPaymentAttempt(tx, scope) {
      const result = await dataPersistence.claimSyntheticPaymentAttempt(tx, scope);
      return normalizeAttemptClaim(result, scope);
    },
    markPaymentAttemptUnknown: dataPersistence.markPaymentAttemptUnknown.bind(dataPersistence),
    readUnknownPaymentAttempt: dataPersistence.readUnknownPaymentAttempt.bind(dataPersistence),
    upsertReconciliationControl: dataPersistence.upsertReconciliationControl.bind(dataPersistence),
    readReconciliationControl: dataPersistence.readReconciliationControl.bind(dataPersistence),
    createOutboxJob: outboxPersistence.createOutboxJob.bind(outboxPersistence),
  });
}
