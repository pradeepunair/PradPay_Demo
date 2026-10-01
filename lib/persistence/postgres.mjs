import { createHash, randomUUID } from "node:crypto";

import { assertSafeEventPayload } from "../events/safe-payload.mjs";

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}
function transaction(tx) {
  if (!tx || typeof tx.query !== "function") throw new TypeError("a transaction-scoped query client is required");
  return tx;
}

function projectLineItems(items) {
  if (!Array.isArray(items)) return undefined;
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("line_items entries must be objects");
    required(item.id, "line_items[].id");
    return { id: item.id, item: structuredClone(item), quantity: 1, totals: [] };
  });
}

function projectCapabilities(capabilities) {
  const projected = { payment: { handlers: [] } };
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return projected;
  if (capabilities.interventions !== undefined) projected.interventions = structuredClone(capabilities.interventions);
  if (Array.isArray(capabilities.extensions) && capabilities.extensions.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    projected.extensions = structuredClone(capabilities.extensions);
  }
  return projected;
}

function copyDefined(target, source, fields) {
  for (const field of fields) if (source[field] !== undefined) target[field] = structuredClone(source[field]);
}

export class PostgresPersistence {
  constructor(pool) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("pool.connect is required");
    this.pool = pool;
  }

  async withTransaction(work) {
    if (typeof work !== "function") throw new TypeError("work must be a function");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    } finally {
      client.release();
    }
  }

  async appendDomainEvent(tx, event) {
    transaction(tx);
    for (const name of ["eventId", "runId", "sessionId", "type", "schemaVersion"]) required(event?.[name], name);
    assertSafeEventPayload(event.safePayload);
    const result = await tx.query(
      "SELECT append_domain_event($1,$2,$3,$4,$5,$6::jsonb) AS sequence",
      [event.eventId, event.runId, event.sessionId, event.type, event.schemaVersion, JSON.stringify(event.safePayload)],
    );
    return { ...event, sequence: Number(result.rows[0].sequence) };
  }

  async claimIdempotency(tx, claim) {
    transaction(tx);
    for (const name of ["sessionId", "scope", "key", "requestHash"]) required(claim?.[name], name);
    const result = await tx.query(
      "SELECT claim_idempotency($1,$2,$3,$4) AS outcome",
      [claim.sessionId, claim.scope, claim.key, claim.requestHash],
    );
    return result.rows[0].outcome;
  }

  async recordWebhookReceipt(tx, receipt) {
    transaction(tx);
    for (const forbidden of ["rawPayload", "rawBody", "secret", "signature"]) {
      if (Object.hasOwn(receipt ?? {}, forbidden)) throw new TypeError(`${forbidden} is not accepted`);
    }
    assertSafeEventPayload(receipt, "receipt");
    for (const name of ["id", "provider", "providerEventId", "eventType"]) required(receipt?.[name], name);
    const result = await tx.query(
      "SELECT record_webhook_receipt($1,$2,$3,$4,$5::jsonb,$6::timestamptz) AS outcome",
      [receipt.id, receipt.provider, receipt.providerEventId, receipt.eventType, JSON.stringify(receipt.safePayload), receipt.occurredAt ?? null],
    );
    return result.rows[0].outcome;
  }

  async createOutboxJob(tx, job) {
    transaction(tx);
    for (const name of ["id", "sessionId", "runId", "kind", "dedupeKey"]) required(job?.[name], name);
    assertSafeEventPayload(job.safePayload);
    if (job.maxAttempts !== undefined && (!Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1)) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
    const result = await tx.query(
      `INSERT INTO outbox_jobs(id,session_id,run_id,kind,dedupe_key,safe_payload,available_at,max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,COALESCE($7::timestamptz,now()),COALESCE($8,8))
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      [job.id, job.sessionId, job.runId, job.kind, job.dedupeKey, JSON.stringify(job.safePayload), job.availableAt ?? null, job.maxAttempts ?? null],
    );
    return result.rows[0] ? { outcome: "created", job: result.rows[0] } : { outcome: "duplicate" };
  }

  async leaseOutboxJobs(tx, { owner, limit = 10, leaseMs = 30_000, token = randomUUID() }) {
    transaction(tx); required(owner, "owner"); required(token, "token");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be between 1 and 100");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new RangeError("leaseMs must be positive");
    const result = await tx.query(
      `WITH exhausted AS (
         UPDATE outbox_jobs SET state='dead',lease_owner=NULL,lease_token=NULL,
                lease_expires_at=NULL,updated_at=now()
          WHERE attempt_count>=max_attempts
            AND ((state='pending' AND available_at<=now()) OR (state='leased' AND lease_expires_at<=now()))
          RETURNING id
       ), candidates AS (
         SELECT id FROM outbox_jobs
          WHERE ((state='pending' AND available_at<=now()) OR (state='leased' AND lease_expires_at<=now()))
            AND attempt_count < max_attempts
          ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE outbox_jobs j SET state='leased',lease_owner=$2,lease_token=$3,
              lease_expires_at=now()+($4*interval '1 millisecond'),attempt_count=j.attempt_count+1,updated_at=now()
        FROM candidates c WHERE j.id=c.id RETURNING j.*`,
      [limit, owner, token, leaseMs],
    );
    return result.rows;
  }

  async ackOutboxJob(tx, { id, owner, token }) {
    transaction(tx); required(id, "id"); required(owner, "owner"); required(token, "token");
    const result = await tx.query(
      `UPDATE outbox_jobs SET state='succeeded',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE id=$1 AND state='leased' AND lease_owner=$2 AND lease_token=$3 AND lease_expires_at>now() RETURNING id`,
      [id, owner, token],
    );
    return result.rowCount === 1;
  }

  async failOutboxJob(tx, { id, owner, token, terminal = false, errorCode, availableAt }) {
    transaction(tx);
    for (const [value, name] of [[id,"id"],[owner,"owner"],[token,"token"],[errorCode,"errorCode"]]) required(value, name);
    if (typeof terminal !== "boolean") throw new TypeError("terminal must be boolean");
    const result = await tx.query(
      `UPDATE outbox_jobs SET state=CASE WHEN $5::boolean OR attempt_count>=max_attempts THEN 'dead' ELSE 'pending' END,
              available_at=COALESCE($6::timestamptz,now()),last_error_code=$4,
              lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE id=$1 AND state='leased' AND lease_owner=$2 AND lease_token=$3 AND lease_expires_at>now() RETURNING *`,
      [id, owner, token, errorCode, terminal, availableAt ?? null],
    );
    return result.rows[0] ?? null;
  }

  async getRun(tx, { sessionId, runId }) {
    transaction(tx); required(sessionId, "sessionId"); required(runId, "runId");
    const result = await tx.query("SELECT * FROM runs WHERE session_id=$1 AND id=$2", [sessionId, runId]);
    return result.rows[0] ?? null;
  }

  async createVisitorSession(tx, { id, expiresAt, admissionLimit }) {
    transaction(tx); required(id, "id"); required(expiresAt, "expiresAt");
    if (!Number.isSafeInteger(admissionLimit) || admissionLimit < 1 || admissionLimit > 10) {
      throw new RangeError("admissionLimit must be between 1 and 10");
    }
    const result = await tx.query(
      `INSERT INTO visitor_sessions(id,expires_at,admission_limit)
       VALUES ($1,$2::timestamptz,$3) RETURNING id,expires_at,admission_limit`,
      [id, expiresAt, admissionLimit],
    );
    return result.rows[0];
  }

  async hasActiveVisitorSession(tx, { sessionId }) {
    transaction(tx); required(sessionId, "sessionId");
    const result = await tx.query(
      "SELECT 1 FROM visitor_sessions WHERE id=$1 AND expires_at>now()",
      [sessionId],
    );
    return result.rowCount === 1;
  }

  async getActiveVisitorSession(tx, { sessionId }) {
    transaction(tx); required(sessionId, "sessionId");
    const result = await tx.query(
      "SELECT expires_at FROM visitor_sessions WHERE id=$1 AND expires_at>now()",
      [sessionId],
    );
    return result.rows[0] ?? null;
  }

  async createOwnedRun(tx, { sessionId, runId, scenario, referenceTime }) {
    transaction(tx);
    for (const [value, name] of [[sessionId,"sessionId"],[runId,"runId"],[scenario,"scenario"],[referenceTime,"referenceTime"]]) required(value, name);
    const admitted = await tx.query(
      `UPDATE visitor_sessions SET admitted_count=admitted_count+1
       WHERE id=$1 AND expires_at>now() AND admitted_count<admission_limit
       RETURNING id`,
      [sessionId],
    );
    if (admitted.rowCount !== 1) return null;
    const result = await tx.query(
      `INSERT INTO runs(id,session_id,mode,scenario,state,reference_time,schema_version)
       VALUES ($1,$2,'live_sandbox',$3,'queued',$4::timestamptz,'1.0.0')
       RETURNING id,session_id,mode,scenario,state,reference_time,next_event_sequence`,
      [runId, sessionId, scenario, referenceTime],
    );
    return result.rows[0];
  }

  async listOwnedRunEvents(tx, { sessionId, runId, afterSequence = 0, limit = 50 }) {
    transaction(tx); required(sessionId, "sessionId"); required(runId, "runId");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError("afterSequence must be non-negative");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be between 1 and 100");
    const result = await tx.query(
      `SELECT event_id,sequence,type,schema_version,safe_payload,occurred_at
       FROM domain_events WHERE session_id=$1 AND run_id=$2 AND sequence>$3
       ORDER BY sequence ASC LIMIT $4`,
      [sessionId, runId, afterSequence, limit],
    );
    return result.rows;
  }

  async getCheckout(tx, { sessionId, checkoutId }) {
    transaction(tx); required(sessionId, "sessionId"); required(checkoutId, "checkoutId");
    const result = await tx.query("SELECT * FROM checkouts WHERE session_id=$1 AND id=$2", [sessionId, checkoutId]);
    return result.rows[0] ?? null;
  }

  async readSafetyControl(tx, { environment }) {
    transaction(tx); required(environment, "environment");
    const result = await tx.query(
      "SELECT payment_admission_enabled,version,reason_code FROM safety_controls WHERE environment=$1",
      [environment],
    );
    const row = result.rows[0];
    if (!row) return { paymentAdmissionEnabled: false, version: 0, reasonCode: "missing_control" };
    return {
      paymentAdmissionEnabled: row.payment_admission_enabled,
      version: Number(row.version),
      reasonCode: row.reason_code,
    };
  }

  async setSafetyControl(tx, { environment, paymentAdmissionEnabled, expectedVersion, reasonCode }) {
    transaction(tx); required(environment, "environment"); required(reasonCode, "reasonCode");
    if (typeof paymentAdmissionEnabled !== "boolean") throw new TypeError("paymentAdmissionEnabled must be boolean");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new RangeError("expectedVersion must be a non-negative integer");
    let result;
    if (expectedVersion === 0) {
      result = await tx.query(
        `INSERT INTO safety_controls(environment,payment_admission_enabled,version,reason_code)
         VALUES ($1,$2,1,$3) ON CONFLICT (environment) DO NOTHING
         RETURNING payment_admission_enabled,version,reason_code`,
        [environment, paymentAdmissionEnabled, reasonCode],
      );
    } else {
      result = await tx.query(
        `UPDATE safety_controls SET payment_admission_enabled=$2,version=version+1,reason_code=$3,updated_at=now()
          WHERE environment=$1 AND version=$4
          RETURNING payment_admission_enabled,version,reason_code`,
        [environment, paymentAdmissionEnabled, reasonCode, expectedVersion],
      );
    }
    const row = result.rows[0];
    if (!row) return { status: "conflict" };
    return { status: "updated", record: {
      paymentAdmissionEnabled: row.payment_admission_enabled,
      version: Number(row.version),
      reasonCode: row.reason_code,
    } };
  }

  async reserveSyntheticBudget(tx, claim) {
    transaction(tx);
    for (const name of ["id", "environment", "policyId", "sessionId", "runId", "operationKey", "attemptId", "requestHash"]) {
      required(claim?.[name], name);
    }
    if (!Number.isSafeInteger(claim.amountMinor) || claim.amountMinor < 0) {
      throw new RangeError("amountMinor must be a non-negative safe integer");
    }
    const result = await tx.query(
      "SELECT reserve_synthetic_budget($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint) AS outcome",
      [claim.id, claim.environment, claim.policyId, claim.sessionId, claim.runId,
        claim.operationKey, claim.attemptId, claim.requestHash, claim.amountMinor],
    );
    return result.rows[0].outcome;
  }

  async upsertReconciliationControl(tx, control) {
    transaction(tx);
    for (const name of ["id", "sessionId", "runId", "attemptId"]) required(control?.[name], name);
    const result = await tx.query(
      `INSERT INTO synthetic_reconciliation_controls(id,session_id,run_id,attempt_id,state,next_check_at,last_result_code)
       VALUES ($1,$2,$3,$4,'pending',COALESCE($5::timestamptz,now()),$6)
       ON CONFLICT (session_id,run_id,attempt_id) DO UPDATE
         SET next_check_at=LEAST(synthetic_reconciliation_controls.next_check_at,EXCLUDED.next_check_at),updated_at=now()
       RETURNING *`,
      [control.id, control.sessionId, control.runId, control.attemptId, control.nextCheckAt ?? null, control.resultCode ?? null],
    );
    return result.rows[0];
  }

  async readReconciliationControl(tx, { sessionId, runId, attemptId }) {
    transaction(tx);
    for (const [value, name] of [[sessionId,"sessionId"],[runId,"runId"],[attemptId,"attemptId"]]) required(value, name);
    const result = await tx.query(
      "SELECT * FROM synthetic_reconciliation_controls WHERE session_id=$1 AND run_id=$2 AND attempt_id=$3",
      [sessionId, runId, attemptId],
    );
    return result.rows[0] ?? null;
  }

  async updateReconciliationControl(tx, { sessionId, runId, attemptId, expectedVersion, state, nextCheckAt, resultCode }) {
    transaction(tx);
    for (const [value, name] of [[sessionId,"sessionId"],[runId,"runId"],[attemptId,"attemptId"],[state,"state"]]) required(value, name);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new RangeError("expectedVersion must be positive");
    const result = await tx.query(
      `UPDATE synthetic_reconciliation_controls
          SET state=$5,version=version+1,next_check_at=COALESCE($6::timestamptz,next_check_at),
              last_result_code=$7,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE session_id=$1 AND run_id=$2 AND attempt_id=$3 AND version=$4 RETURNING *`,
      [sessionId, runId, attemptId, expectedVersion, state, nextCheckAt ?? null, resultCode ?? null],
    );
    return result.rows[0] ? { status: "updated", record: result.rows[0] } : { status: "conflict_or_not_found" };
  }

  async claimSyntheticPaymentAttempt(tx, { sessionId, runId, attemptId, operationId, requestHash }) {
    transaction(tx);
    for (const [value, name] of [[sessionId,"sessionId"],[runId,"runId"],[attemptId,"attemptId"],[operationId,"operationId"],[requestHash,"requestHash"]]) required(value, name);
    const result = await tx.query(
      `WITH candidate AS MATERIALIZED (
         SELECT * FROM payment_attempts
          WHERE session_id=$1 AND run_id=$2 AND id=$3 AND operation_key=$4 AND request_hash=$5
          FOR UPDATE
       ), transitioned AS (
         UPDATE payment_attempts p SET state='submitted',updated_at=now()
          FROM candidate c WHERE p.id=c.id AND c.state='prepared'
          RETURNING p.*
       )
       SELECT * FROM transitioned
       UNION ALL
       SELECT * FROM candidate WHERE state='submitted' AND NOT EXISTS (SELECT 1 FROM transitioned)
       LIMIT 1`,
      [sessionId, runId, attemptId, operationId, requestHash],
    );
    return result.rows[0] ? { status: "ready", attempt: result.rows[0] } : { status: "rejected" };
  }

  async markPaymentAttemptUnknown(tx, { sessionId, runId, attemptId, operationId }) {
    transaction(tx);
    for (const [value, name] of [[sessionId,"sessionId"],[runId,"runId"],[attemptId,"attemptId"],[operationId,"operationId"]]) required(value, name);
    const result = await tx.query(
      `UPDATE payment_attempts SET state='unknown',updated_at=now()
        WHERE session_id=$1 AND run_id=$2 AND id=$3 AND operation_key=$4
          AND state IN ('submitted','processing','unknown')
        RETURNING *`,
      [sessionId, runId, attemptId, operationId],
    );
    return result.rows[0] ? { status: "updated", attempt: result.rows[0] } : { status: "rejected" };
  }

  async readUnknownPaymentAttempt(tx, { sessionId, runId, attemptId }) {
    transaction(tx);
    for (const [value, name] of [[sessionId,"sessionId"],[runId,"runId"],[attemptId,"attemptId"]]) required(value, name);
    const result = await tx.query(
      "SELECT * FROM payment_attempts WHERE session_id=$1 AND run_id=$2 AND id=$3 AND state='unknown'",
      [sessionId, runId, attemptId],
    );
    return result.rows[0] ?? null;
  }

  async consumeJitNonce(tx, receipt) {
    transaction(tx);
    for (const name of [
      "nonce", "candidateCommit", "requestHash", "endpoint", "accountId",
      "paymentMethodFingerprint", "apiVersion", "acpVersion", "operatorIdentity",
      "issuedAt", "expiresAt",
    ]) required(receipt?.[name], name);
    const result = await tx.query(
      "SELECT consume_jit_nonce($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz) AS outcome",
      [receipt.nonce, receipt.candidateCommit, receipt.requestHash, receipt.endpoint, receipt.accountId,
        receipt.paymentMethodFingerprint, receipt.apiVersion, receipt.acpVersion, receipt.operatorIdentity,
        receipt.issuedAt, receipt.expiresAt],
    );
    const status = result.rows[0]?.outcome;
    if (!["consumed", "replay"].includes(status)) throw new Error("Persistence returned an invalid JIT nonce outcome.");
    return { status };
  }

  async claimAcpIdempotency(tx, claim) {
    transaction(tx);
    for (const name of ["subject", "sessionId", "runId", "scope", "key", "requestHash"]) required(claim?.[name], name);
    const owner = await tx.query("SELECT 1 FROM runs WHERE session_id=$1 AND id=$2", [claim.sessionId, claim.runId]);
    if (!owner.rows[0]) return { status: "forbidden" };
    const durableScope = `acp:${claim.subject}:${claim.runId}:${claim.scope}`;
    const result = await tx.query(
      "SELECT claim_idempotency($1,$2,$3,$4) AS outcome",
      [claim.sessionId, durableScope, claim.key, claim.requestHash],
    );
    const status = result.rows[0].outcome;
    if (status !== "replay") return { status };
    const replay = await tx.query(
      "SELECT result FROM idempotency_keys WHERE session_id=$1 AND scope=$2 AND key=$3 AND request_hash=$4",
      [claim.sessionId, durableScope, claim.key, claim.requestHash],
    );
    return replay.rows[0]?.result ? { status: "replay", response: replay.rows[0].result } : { status: "pending" };
  }

  async storeAcpIdempotentResponse(tx, record) {
    transaction(tx);
    for (const name of ["subject", "sessionId", "runId", "scope", "key", "requestHash"]) required(record?.[name], name);
    assertSafeEventPayload(record.response, "response");
    const durableScope = `acp:${record.subject}:${record.runId}:${record.scope}`;
    const result = await tx.query(
      `UPDATE idempotency_keys SET result=$5::jsonb,updated_at=now()
        WHERE session_id=$1 AND scope=$2 AND key=$3 AND request_hash=$4 AND result IS NULL RETURNING key`,
      [record.sessionId, durableScope, record.key, record.requestHash, JSON.stringify(record.response)],
    );
    return result.rowCount === 1 ? { status: "stored" } : { status: "conflict" };
  }

  async createAcpCheckout(tx, args) {
    transaction(tx);
    for (const name of ["subject", "sessionId", "runId", "requestId", "apiVersion"]) required(args?.[name], name);
    if (args.apiVersion !== "2026-04-17") throw new RangeError("unsupported ACP version");
    if (!args.input || typeof args.input !== "object" || Array.isArray(args.input)) throw new TypeError("input must be an object");
    assertSafeEventPayload(args.input, "input");
    const checkoutId = `cs_${randomUUID().replaceAll("-", "")}`;
    const cartHash = createHash("sha256").update(JSON.stringify(args.input)).digest("hex");
    const document = {
      id: checkoutId,
      status: "ready_for_payment",
      currency: args.input.currency,
      line_items: projectLineItems(args.input.line_items) ?? [],
      totals: [], fulfillment_options: [], messages: [], links: [],
      capabilities: projectCapabilities(args.input.capabilities),
    };
    copyDefined(document, args.input, ["buyer", "fulfillment_details", "fulfillment_groups", "locale", "timezone", "metadata", "quote_id"]);
    await tx.query(
      `INSERT INTO checkouts(id,session_id,run_id,acp_version,state,cart_version,cart_hash)
       VALUES ($1,$2,$3,$4,'ready',1,$5)`,
      [checkoutId, args.sessionId, args.runId, args.apiVersion, cartHash],
    );
    await tx.query(
      `INSERT INTO acp_checkout_documents(checkout_id,subject,session_id,run_id,document)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [checkoutId, args.subject, args.sessionId, args.runId, JSON.stringify(document)],
    );
    return { status: "created", checkout: document };
  }

  async retrieveAcpCheckout(tx, { checkoutSessionId, subject, sessionId, runId, apiVersion }) {
    transaction(tx);
    for (const [value, name] of [[checkoutSessionId,"checkoutSessionId"],[subject,"subject"],[sessionId,"sessionId"],[runId,"runId"],[apiVersion,"apiVersion"]]) required(value, name);
    if (apiVersion !== "2026-04-17") throw new RangeError("unsupported ACP version");
    const result = await tx.query(
      `SELECT d.document FROM acp_checkout_documents d JOIN checkouts c ON c.id=d.checkout_id
        WHERE d.checkout_id=$1 AND d.subject=$2 AND d.session_id=$3 AND d.run_id=$4 AND c.acp_version=$5`,
      [checkoutSessionId, subject, sessionId, runId, apiVersion],
    );
    return result.rows[0] ? { status: "found", checkout: result.rows[0].document } : { status: "not_found" };
  }

  async readAcpCheckout(tx, args) { return this.retrieveAcpCheckout(tx, args); }

  async updateAcpCheckout(tx, args) {
    transaction(tx);
    for (const name of ["checkoutSessionId", "subject", "sessionId", "runId", "apiVersion"]) required(args?.[name], name);
    if (args.apiVersion !== "2026-04-17") throw new RangeError("unsupported ACP version");
    if (!args.input || typeof args.input !== "object" || Array.isArray(args.input)) throw new TypeError("input must be an object");
    assertSafeEventPayload(args.input, "input");
    const locked = await tx.query(
      `SELECT d.document FROM acp_checkout_documents d JOIN checkouts c ON c.id=d.checkout_id
        WHERE d.checkout_id=$1 AND d.subject=$2 AND d.session_id=$3 AND d.run_id=$4 AND c.acp_version=$5
        FOR UPDATE OF d,c`,
      [args.checkoutSessionId, args.subject, args.sessionId, args.runId, args.apiVersion],
    );
    if (!locked.rows[0]) return { status: "not_found" };
    const current = locked.rows[0].document;
    if (current.status === "canceled") return { status: "updated", checkout: current };
    const document = {
      ...current,
      status: "incomplete",
      ...(typeof args.input.order_notes === "string" ? { metadata: { ...(current.metadata ?? {}), note: args.input.order_notes } } : {}),
    };
    if (args.input.line_items !== undefined) document.line_items = projectLineItems(args.input.line_items);
    copyDefined(document, args.input, ["buyer", "fulfillment_details", "fulfillment_groups", "selected_fulfillment_options"]);
    const result = await tx.query(
      `UPDATE acp_checkout_documents SET document=$6::jsonb,version=version+1,updated_at=now()
        WHERE checkout_id=$1 AND subject=$2 AND session_id=$3 AND run_id=$4
          AND EXISTS (SELECT 1 FROM checkouts WHERE id=$1 AND acp_version=$5)
        RETURNING checkout_id`,
      [args.checkoutSessionId, args.subject, args.sessionId, args.runId, args.apiVersion, JSON.stringify(document)],
    );
    if (!result.rows[0]) return { status: "not_found" };
    await tx.query(
      "UPDATE checkouts SET state='draft',cart_version=cart_version+1,updated_at=now() WHERE id=$1 AND session_id=$2 AND run_id=$3",
      [args.checkoutSessionId, args.sessionId, args.runId],
    );
    return { status: "updated", checkout: document };
  }

  async cancelAcpCheckout(tx, args) {
    transaction(tx);
    for (const name of ["checkoutSessionId", "subject", "sessionId", "runId", "apiVersion"]) required(args?.[name], name);
    if (args.apiVersion !== "2026-04-17") throw new RangeError("unsupported ACP version");
    const locked = await tx.query(
      `SELECT d.document FROM acp_checkout_documents d JOIN checkouts c ON c.id=d.checkout_id
        WHERE d.checkout_id=$1 AND d.subject=$2 AND d.session_id=$3 AND d.run_id=$4 AND c.acp_version=$5
        FOR UPDATE OF d,c`,
      [args.checkoutSessionId, args.subject, args.sessionId, args.runId, args.apiVersion],
    );
    if (!locked.rows[0]) return { status: "not_found" };
    const current = locked.rows[0].document;
    if (current.status === "canceled") return { status: "canceled", checkout: current };
    const document = { ...current, status: "canceled" };
    const result = await tx.query(
      `UPDATE acp_checkout_documents SET document=$6::jsonb,version=version+1,updated_at=now()
        WHERE checkout_id=$1 AND subject=$2 AND session_id=$3 AND run_id=$4
          AND EXISTS (SELECT 1 FROM checkouts WHERE id=$1 AND acp_version=$5)
        RETURNING checkout_id`,
      [args.checkoutSessionId, args.subject, args.sessionId, args.runId, args.apiVersion, JSON.stringify(document)],
    );
    if (!result.rows[0]) return { status: "not_found" };
    await tx.query(
      "UPDATE checkouts SET state='canceled',cart_version=cart_version+1,updated_at=now() WHERE id=$1 AND session_id=$2 AND run_id=$3",
      [args.checkoutSessionId, args.sessionId, args.runId],
    );
    return { status: "canceled", checkout: document };
  }
}

export function createPostgresPersistence(pool) { return new PostgresPersistence(pool); }
