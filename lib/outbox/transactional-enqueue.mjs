function requireMethod(persistence, method) {
  if (typeof persistence?.[method] !== "function") {
    throw new TypeError(`Transactional outbox requires ${method}().`);
  }
}

export async function commitConsequentialAction({
  persistence,
  mutate,
  event,
  outboxJob,
}) {
  for (const method of ["withTransaction", "appendDomainEvent", "createOutboxJob"]) {
    requireMethod(persistence, method);
  }
  if (typeof mutate !== "function") throw new TypeError("Transactional outbox requires mutate().");
  if (!event?.eventId || !event?.runId || !event?.sessionId) {
    throw new TypeError("Transactional outbox requires a scoped domain event.");
  }
  if (!outboxJob?.dedupeKey || !outboxJob?.type) {
    throw new TypeError("Transactional outbox requires a dedupe-keyed job.");
  }
  if (!outboxJob.sessionId || !outboxJob.runId) {
    throw new TypeError("Transactional outbox requires a scoped outbox job.");
  }
  if (outboxJob.sessionId !== event.sessionId || outboxJob.runId !== event.runId) {
    throw new TypeError("Outbox job scope must match the domain event scope.");
  }

  return persistence.withTransaction(async (tx) => {
    const createdJob = await persistence.createOutboxJob(tx, outboxJob);
    if (createdJob?.status === "duplicate") {
      return {
        disposition: "duplicate",
        businessResult: null,
        appendedEvent: null,
        outboxJob: createdJob,
      };
    }
    if (createdJob?.status !== "created") {
      throw new Error("Outbox persistence returned an invalid disposition.");
    }
    const businessResult = await mutate(tx);
    const appendedEvent = await persistence.appendDomainEvent(tx, event);
    return { disposition: "created", businessResult, appendedEvent, outboxJob: createdJob };
  });
}
