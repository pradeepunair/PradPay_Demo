export class IdempotencyConflictError extends Error {
  constructor() {
    super("Operation key was already used with different request parameters.");
    this.name = "IdempotencyConflictError";
    this.code = "IDEMPOTENCY_CONFLICT";
    this.retryable = false;
  }
}

function validateClaim(claim) {
  for (const field of ["sessionId", "scope", "key"]) {
    if (typeof claim?.[field] !== "string" || claim[field].length === 0) {
      throw new TypeError(`Idempotency claim requires ${field}.`);
    }
  }
  if (typeof claim?.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(claim.requestHash)) {
    throw new TypeError("Idempotency claim requires a lowercase SHA-256 requestHash.");
  }
}

export async function claimOperation({ persistence, claim, createOperation, readOperation }) {
  validateClaim(claim);
  if (typeof persistence?.withTransaction !== "function"
    || typeof persistence?.claimIdempotency !== "function") {
    throw new TypeError("Operation service requires the persistence idempotency port.");
  }
  if (typeof createOperation !== "function") {
    throw new TypeError("Operation service requires createOperation().");
  }
  if (typeof readOperation !== "function") {
    throw new TypeError("Operation service requires readOperation().");
  }

  return persistence.withTransaction(async (tx) => {
    const result = await persistence.claimIdempotency(tx, claim);
    if (result?.status === "conflict") throw new IdempotencyConflictError();
    if (result?.status === "replay") {
      const operation = await readOperation(tx, { claim, idempotency: result.record });
      if (!operation) throw new Error("Idempotency replay is missing its durable operation result.");
      return { disposition: "replay", operation };
    }
    if (result?.status !== "created") {
      throw new Error("Idempotency persistence returned an invalid disposition.");
    }

    const operation = await createOperation(tx, { claim, idempotency: result.record });
    if (!operation?.operationId) throw new Error("Created operation requires operationId.");
    return { disposition: "created", operation };
  });
}
