import { randomUUID } from "node:crypto";

function requireMethod(persistence, method) {
  if (typeof persistence?.[method] !== "function") {
    throw new TypeError(`Reliability persistence adapter requires ${method}().`);
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function generatedId(createId, prefix) {
  const value = createId(prefix);
  requiredString(value, `${prefix} id`);
  return value;
}

function timestamp(value) {
  if (value === null || value === undefined) return undefined;
  const milliseconds = typeof value === "number" && value < 10_000_000_000 ? value * 1_000 : value;
  const result = new Date(milliseconds).toISOString();
  return result;
}

function rowValue(row, camel, snake) {
  return row?.[camel] ?? row?.[snake];
}

function normalizeJob(row) {
  return Object.freeze({
    id: rowValue(row, "id", "id"),
    type: rowValue(row, "type", "kind"),
    dedupeKey: rowValue(row, "dedupeKey", "dedupe_key"),
    sessionId: rowValue(row, "sessionId", "session_id"),
    runId: rowValue(row, "runId", "run_id"),
    safePayload: rowValue(row, "safePayload", "safe_payload"),
    attempts: Number(rowValue(row, "attempts", "attempt_count") ?? 0),
    leaseOwner: rowValue(row, "leaseOwner", "lease_owner"),
    leaseToken: rowValue(row, "leaseToken", "lease_token"),
    leaseExpiresAt: rowValue(row, "leaseExpiresAt", "lease_expires_at"),
  });
}

export function createReliabilityPersistenceAdapter(
  persistence,
  { createId = (prefix) => `${prefix}_${randomUUID()}` } = {},
) {
  for (const method of [
    "withTransaction",
    "appendDomainEvent",
    "claimIdempotency",
    "recordWebhookReceipt",
    "createOutboxJob",
    "leaseOutboxJobs",
    "ackOutboxJob",
    "failOutboxJob",
  ]) requireMethod(persistence, method);
  if (typeof createId !== "function") throw new TypeError("createId must be a function");

  return Object.freeze({
    withTransaction: (work) => persistence.withTransaction(work),
    appendDomainEvent: (tx, event) => persistence.appendDomainEvent(tx, event),

    async claimIdempotency(tx, claim) {
      const status = await persistence.claimIdempotency(tx, claim);
      if (!["created", "replay", "conflict"].includes(status)) {
        throw new Error("Persistence returned an invalid idempotency outcome.");
      }
      return { status, record: Object.freeze({ ...claim }) };
    },

    async recordWebhookReceipt(tx, receipt) {
      const status = await persistence.recordWebhookReceipt(tx, {
        id: generatedId(createId, "webhook"),
        provider: receipt.provider,
        providerEventId: receipt.providerEventId,
        eventType: receipt.type,
        safePayload: {
          livemode: receipt.livemode,
          providerCreatedAt: receipt.providerCreatedAt,
          receivedAt: receipt.receivedAt,
          payloadSha256: receipt.payloadSha256,
        },
        occurredAt: timestamp(receipt.providerCreatedAt),
      });
      if (!["created", "duplicate"].includes(status)) {
        throw new Error("Persistence returned an invalid webhook receipt outcome.");
      }
      return { status, receipt };
    },

    async createOutboxJob(tx, job) {
      const result = await persistence.createOutboxJob(tx, {
        id: job.id ?? generatedId(createId, "outbox"),
        sessionId: job.sessionId,
        runId: job.runId,
        kind: job.type,
        dedupeKey: job.dedupeKey,
        safePayload: job.safePayload ?? {},
        availableAt: timestamp(job.availableAt),
        maxAttempts: job.maxAttempts,
      });
      const status = result?.outcome;
      if (!["created", "duplicate"].includes(status)) {
        throw new Error("Persistence returned an invalid outbox creation outcome.");
      }
      return { status, job: result.job ? normalizeJob(result.job) : undefined };
    },

    async leaseOutboxJobs({ owner, limit, leaseMs }) {
      return persistence.withTransaction(async (tx) => {
        const rows = await persistence.leaseOutboxJobs(tx, { owner, limit, leaseMs });
        return rows.map(normalizeJob);
      });
    },

    async ackOutboxJob({ jobId, owner, leaseToken }) {
      const acknowledged = await persistence.withTransaction((tx) => persistence.ackOutboxJob(tx, {
        id: jobId,
        owner,
        token: leaseToken,
      }));
      return { status: acknowledged ? "acked" : "stale_fence" };
    },

    async failOutboxJob({ jobId, owner, leaseToken, terminal, nextAttemptAt, errorCode }) {
      const row = await persistence.withTransaction((tx) => persistence.failOutboxJob(tx, {
        id: jobId,
        owner,
        token: leaseToken,
        terminal,
        errorCode,
        availableAt: timestamp(nextAttemptAt),
      }));
      if (!row) return { status: "stale_fence" };
      const state = rowValue(row, "state", "state");
      return { status: terminal || ["dead", "failed"].includes(state) ? "terminal" : "retry_scheduled" };
    },
  });
}
