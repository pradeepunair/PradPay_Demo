import {
  recordAndScheduleUnknownOutcome,
  scheduleDurablyVerifiedReconciliation,
} from "../reconciliation/unknown-outcomes.mjs";

const admittedStatuses = new Set(["reserved", "replay"]);
const blockedStatuses = new Set(["conflict", "kill_switch", "budget_exhausted"]);

const claimSyntheticPaymentAttempt = Object.freeze({
  required: true,
  exactStatus: "ready",
  requiredAttemptState: "submitted",
});

function requireMethod(value, method) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`Local safety persistence requires ${method}().`);
  }
}

function validateClaim(claim) {
  for (const field of [
    "environment",
    "admissionId",
    "policyId",
    "sessionId",
    "runId",
    "operationId",
    "attemptId",
    "idempotencyKey",
  ]) {
    if (typeof claim?.[field] !== "string" || claim[field].length === 0) {
      throw new TypeError(`Synthetic admission requires ${field}.`);
    }
  }
  if (typeof claim.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(claim.requestHash)) {
    throw new TypeError("Synthetic admission requires a lowercase SHA-256 requestHash.");
  }
  if (!Number.isSafeInteger(claim.amountMinor) || claim.amountMinor < 0) {
    throw new TypeError("Synthetic admission requires non-negative integer amountMinor.");
  }
}

function adapterFailure() {
  return Object.freeze({
    status: "adapter_failure",
    admitted: false,
    retryable: true,
    reasonCode: "SAFETY_ADAPTER_UNAVAILABLE",
  });
}

export function createLocalSafetyController({ persistence }) {
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
    requireMethod(persistence, method);
  }

  async function admitSynthetic(claim) {
    validateClaim(claim);
    try {
      return await persistence.withTransaction(async (tx) => {
        const control = await persistence.readSafetyControl(tx, {
          environment: claim.environment,
        });
        const reservation = await persistence.reserveSyntheticBudget(tx, {
          id: claim.admissionId,
          environment: claim.environment,
          policyId: claim.policyId,
          sessionId: claim.sessionId,
          runId: claim.runId,
          operationKey: claim.operationId,
          attemptId: claim.attemptId,
          requestHash: claim.requestHash,
          amountMinor: claim.amountMinor,
        });
        if (!reservation || (!admittedStatuses.has(reservation.status)
          && !blockedStatuses.has(reservation.status))) {
          throw new Error("Safety persistence returned an invalid reservation outcome.");
        }
        if (control?.paymentAdmissionEnabled !== true
          && !["kill_switch", "conflict"].includes(reservation.status)) {
          throw new Error("Disabled safety control returned an unsafe reservation outcome.");
        }
        if (reservation.status === "reserved" || reservation.status === "replay") {
          const scope = {
            sessionId: claim.sessionId,
            runId: claim.runId,
            attemptId: claim.attemptId,
            operationId: claim.operationId,
            requestHash: claim.requestHash,
          };
          const claimResult = await persistence.claimSyntheticPaymentAttempt(tx, scope);
          if (!claimResult || claimResult.status !== claimSyntheticPaymentAttempt.exactStatus) {
            throw new Error("Attempt claim rejected; admission is not eligible.");
          }
          const attempt = claimResult.attempt;
          if (attempt.state !== claimSyntheticPaymentAttempt.requiredAttemptState
            || attempt.operationId !== scope.operationId
            || attempt.requestHash !== scope.requestHash) {
            throw new Error("Attempt claim returned ineligible attempt.");
          }
        }
        const result = Object.freeze({
          ...reservation,
          admitted: admittedStatuses.has(reservation.status),
          retryable: false,
          ...(reservation.status === "kill_switch"
            ? { reasonCode: control?.reasonCode ?? "MISSING_SAFETY_CONTROL" }
            : {}),
        });
        return result;
      });
    } catch {
      return adapterFailure();
    }
  }

  return Object.freeze({
    admitSynthetic,

    async executeSynthetic({ claim, provider, onCallback }) {
      if (typeof provider?.execute !== "function") {
        throw new TypeError("Synthetic execution requires provider.execute().");
      }
      const admission = await admitSynthetic(claim);
      if (!admission.admitted) return admission;
      try {
        const result = await provider.execute({
          operationId: claim.operationId,
          attemptId: claim.attemptId,
          idempotencyKey: claim.idempotencyKey,
          requestHash: claim.requestHash,
        }, { onCallback });
        return Object.freeze({ status: "executed", admitted: true, admission, result });
      } catch (error) {
        if (error?.code !== "SYNTHETIC_TIMEOUT" || error?.outcome !== "unknown") throw error;
        const operation = Object.freeze({
          operationId: claim.operationId,
          attemptId: claim.attemptId,
          sessionId: claim.sessionId,
          runId: claim.runId,
          status: "unknown",
        });
        const reconciliation = await recordAndScheduleUnknownOutcome({ persistence, operation });
        return Object.freeze({
          status: "unknown",
          admitted: true,
          admission,
          operation,
          reconciliation,
          effectRecorded: error.effectRecorded === true,
          effectId: error.effectId ?? null,
          safeEvent: error.safeEvent ?? null,
          createReplacementAttempt: false,
        });
      }
    },

    async scheduleExistingReconciliation(scope) {
      return scheduleDurablyVerifiedReconciliation({ persistence, scope });
    },
  });
}
