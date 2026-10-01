import { createHash, randomBytes, randomUUID } from "node:crypto";

import { assertSafeEventPayload } from "../events/safe-payload.mjs";

export const SESSION_COOKIE = "paymentlab_local_session";
const SESSION_SECONDS = 24 * 60 * 60;

export class RunRequestError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sessionIdForToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new RunRequestError("SESSION_REQUIRED", 401);
  }
  return hash(token);
}

export function normalizeMission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["goal", "requirements"].includes(key))
    || typeof value.goal !== "string" || !Array.isArray(value.requirements)
    || value.requirements.length > 6 || !value.requirements.every((item) => typeof item === "string")) {
    throw new RunRequestError("INVALID_MISSION", 400);
  }
  const goal = value.goal.trim();
  const requirements = value.requirements.map((item) => item.trim());
  if (goal.length < 8 || goal.length > 240 || requirements.some((item) => item.length < 1 || item.length > 100)) {
    throw new RunRequestError("INVALID_MISSION", 400);
  }
  const mission = { goal, requirements };
  try { assertSafeEventPayload(mission); } catch { throw new RunRequestError("INVALID_MISSION", 400); }
  return mission;
}

export function createOwnedRunService({ persistence, now = () => new Date(), tokenFactory = () => randomBytes(32).toString("base64url"), idFactory = randomUUID } = {}) {
  for (const name of ["withTransaction", "createVisitorSession", "hasActiveVisitorSession", "getActiveVisitorSession", "claimIdempotency", "createOwnedRun", "appendDomainEvent", "createOutboxJob", "getRun", "listOwnedRunEvents"]) {
    if (typeof persistence?.[name] !== "function") throw new TypeError(`persistence.${name} is required`);
  }
  return Object.freeze({
    async createSession({ token: existingToken } = {}) {
      if (existingToken) {
        let existingId;
        try { existingId = sessionIdForToken(existingToken); } catch { /* Rotate malformed cookie. */ }
        if (existingId) {
          const existing = await persistence.withTransaction((tx) => persistence.getActiveVisitorSession(tx, { sessionId: existingId }));
          if (existing) return { token: null, expiresAt: new Date(existing.expires_at ?? existing.expiresAt).toISOString(), maxAge: SESSION_SECONDS };
        }
      }
      const token = tokenFactory();
      const id = sessionIdForToken(token);
      const expiresAt = new Date(now().getTime() + SESSION_SECONDS * 1000).toISOString();
      await persistence.withTransaction((tx) => persistence.createVisitorSession(tx, { id, expiresAt, admissionLimit: 3 }));
      return { token, expiresAt, maxAge: SESSION_SECONDS };
    },
    async createRun({ token, idempotencyKey, mission: input }) {
      const sessionId = sessionIdForToken(token);
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
        throw new RunRequestError("IDEMPOTENCY_KEY_REQUIRED", 400);
      }
      const mission = normalizeMission(input);
      const scenario = "buyer_merchant_preparation";
      const requestHash = hash(JSON.stringify({ scenario, mission }));
      const runId = `run_${hash(`${sessionId}:${idempotencyKey}`).slice(0, 48)}`;
      return persistence.withTransaction(async (tx) => {
        if (!await persistence.hasActiveVisitorSession(tx, { sessionId })) throw new RunRequestError("SESSION_REQUIRED", 401);
        const outcome = await persistence.claimIdempotency(tx, { sessionId, scope: "run.create", key: idempotencyKey, requestHash });
        if (outcome === "conflict") throw new RunRequestError("IDEMPOTENCY_CONFLICT", 409);
        if (outcome === "replay") {
          const run = await persistence.getRun(tx, { sessionId, runId });
          if (!run) throw new Error("Idempotent run record unavailable");
          return { runId, state: run.state, replay: true };
        }
        if (outcome !== "created") throw new Error("Invalid idempotency outcome");
        const run = await persistence.createOwnedRun(tx, { sessionId, runId, scenario, referenceTime: now().toISOString() });
        if (!run) throw new RunRequestError("SESSION_LIMIT_OR_EXPIRED", 429);
        await persistence.appendDomainEvent(tx, {
          eventId: idFactory(), sessionId, runId, type: "mission.confirmed", schemaVersion: "1.0.0",
          safePayload: mission,
        });
        const job = await persistence.createOutboxJob(tx, {
          id: idFactory(), sessionId, runId, kind: "run.prepare", dedupeKey: `prepare:${runId}`,
          safePayload: { scenario },
        });
        if (job.outcome !== "created") throw new Error("Run preparation outbox conflict");
        return { runId, state: run.state, replay: false };
      });
    },
    async readRun({ token, runId, afterSequence = 0 }) {
      const sessionId = sessionIdForToken(token);
      if (typeof runId !== "string" || !/^run_[0-9a-f]{48}$/.test(runId)) throw new RunRequestError("RUN_NOT_FOUND", 404);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RunRequestError("INVALID_CURSOR", 400);
      return persistence.withTransaction(async (tx) => {
        if (!await persistence.hasActiveVisitorSession(tx, { sessionId })) throw new RunRequestError("SESSION_REQUIRED", 401);
        const run = await persistence.getRun(tx, { sessionId, runId });
        if (!run) throw new RunRequestError("RUN_NOT_FOUND", 404);
        const events = await persistence.listOwnedRunEvents(tx, { sessionId, runId, afterSequence, limit: 50 });
        return {
          runId, state: run.state, mode: run.mode, scenario: run.scenario,
          cursor: events.length ? Number(events.at(-1).sequence) : afterSequence,
          events: events.map((event) => ({
            eventId: event.event_id, sequence: Number(event.sequence), type: event.type,
            schemaVersion: event.schema_version, safePayload: event.safe_payload,
            occurredAt: event.occurred_at,
          })),
        };
      });
    },
  });
}
