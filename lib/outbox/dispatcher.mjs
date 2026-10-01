import { createHash } from "node:crypto";

const DEFAULTS = Object.freeze({
  limit: 10,
  leaseMs: 30_000,
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
});

export function computeBackoffMs({ attempt, baseDelayMs, maxDelayMs }) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError("attempt must be positive.");
  return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(attempt - 1, 30)));
}

function errorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : "OUTBOX_DELIVERY_FAILED";
}

function emit(observe, event, job, fields = {}) {
  try {
    observe({
      event,
      jobId: job.id,
      jobType: job.type,
      dedupeKeyHash: createHash("sha256").update(job.dedupeKey).digest("hex"),
      attempt: job.attempts + 1,
      ...fields,
    });
  } catch {
    // Observability is best-effort and must not control durable delivery state.
  }
}

export async function dispatchOutboxBatch({
  persistence,
  owner,
  now = Date.now(),
  deliver,
  observe = () => {},
  limit = DEFAULTS.limit,
  leaseMs = DEFAULTS.leaseMs,
  maxAttempts = DEFAULTS.maxAttempts,
  baseDelayMs = DEFAULTS.baseDelayMs,
  maxDelayMs = DEFAULTS.maxDelayMs,
}) {
  for (const method of ["leaseOutboxJobs", "ackOutboxJob", "failOutboxJob"]) {
    if (typeof persistence?.[method] !== "function") {
      throw new TypeError(`Outbox persistence requires ${method}().`);
    }
  }
  if (!owner || typeof deliver !== "function") {
    throw new TypeError("Outbox dispatcher requires owner and deliver().");
  }

  const jobs = await persistence.leaseOutboxJobs({ owner, now, limit, leaseMs });
  const summary = {
    leased: jobs.length,
    acked: 0,
    retryScheduled: 0,
    terminalFailures: 0,
    staleFences: 0,
  };

  for (const job of jobs) {
    emit(observe, "outbox.delivery_started", job);
    try {
      await deliver(Object.freeze({
        id: job.id,
        type: job.type,
        dedupeKey: job.dedupeKey,
        sessionId: job.sessionId,
        runId: job.runId,
        safePayload: job.safePayload,
      }));
      const ack = await persistence.ackOutboxJob({
        jobId: job.id,
        owner,
        leaseToken: job.leaseToken,
      });
      if (ack?.status === "acked") {
        summary.acked += 1;
        emit(observe, "outbox.delivery_acked", job);
      } else {
        summary.staleFences += 1;
        emit(observe, "outbox.ack_stale_fence", job);
      }
    } catch (error) {
      const nextAttempt = job.attempts + 1;
      const terminal = error?.retryable === false || nextAttempt >= maxAttempts;
      const nextAttemptAt = terminal
        ? null
        : now + computeBackoffMs({ attempt: nextAttempt, baseDelayMs, maxDelayMs });
      const failed = await persistence.failOutboxJob({
        jobId: job.id,
        owner,
        leaseToken: job.leaseToken,
        terminal,
        nextAttemptAt,
        errorCode: errorCode(error),
      });
      if (failed?.status === "stale_fence") {
        summary.staleFences += 1;
        emit(observe, "outbox.failure_stale_fence", job);
      } else if (terminal && failed?.status === "terminal") {
        summary.terminalFailures += 1;
        emit(observe, "outbox.delivery_terminal", job, { errorCode: errorCode(error) });
      } else if (!terminal && failed?.status === "retry_scheduled") {
        summary.retryScheduled += 1;
        emit(observe, "outbox.delivery_retry_scheduled", job, {
          errorCode: errorCode(error),
          nextAttemptAt,
        });
      } else {
        throw new Error("Outbox persistence returned an invalid failure disposition.");
      }
    }
  }
  return summary;
}
