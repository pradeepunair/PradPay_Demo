import { createHash } from 'node:crypto';
import { claimOperation } from '../payments/idempotent-operations.mjs';
import { createSyntheticPaymentProvider, SyntheticProviderTimeoutError, reduceSyntheticPaymentEvent } from '../payments/synthetic-provider.mjs';
import { createPostgresPersistence } from '../persistence/postgres.mjs';
import { createReliabilityPersistenceAdapter } from '../persistence/reliability-adapter.mjs';
import { requestStudioQuote, validateStudioMission } from './agent-simulation-commerce.mjs';
import { simulatedQuoteHash, issueSimulatedToken, authorizeSimulatedCheckout } from './agent-simulation-authority.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scenarios = new Set(['succeeded', 'declined', 'duplicate_callback', 'callback_before_response', 'timeout_after_effect', 'timeout_before_effect']);
const publicRow = row => row && ({ operationId: row.operation_id, runId: row.run_id,
  attemptId: row.attempt_id, scenario: row.scenario, status: row.status,
  dispatchCount: row.dispatch_count, authorityState: row.authority_state, quoteHash: row.quote_hash,
  amountMinor: Number(row.amount_minor), currency: row.currency, orderId: row.order_id,
  orderStatus: row.order_status, providerEventId: row.provider_state?.providerEventId ?? null });

export class StudioPaymentError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function studioPaymentConfiguration(env = process.env) {
  if (env.PAYMENTLAB_ENVIRONMENT !== 'local' || env.PAYMENTLAB_DATABASE_MODE !== 'local'
    || env.PAYMENTLAB_STUDIO_DURABLE_ENABLE !== '1') return false;
  try { const url = new URL(env.DATABASE_URL); return ['postgres:', 'postgresql:'].includes(url.protocol)
    && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname); } catch { return false; }
}
export function createStudioPaymentService({ pool, providerFactory = createSyntheticPaymentProvider, now = () => Date.now() }) {
  if (!pool?.query || !pool?.connect) throw new TypeError('PostgreSQL pool required');
  const persistence = createReliabilityPersistenceAdapter(createPostgresPersistence(pool));
  const sessionId = token => {
    if (!uuid.test(token ?? '')) throw new StudioPaymentError('SESSION_REQUIRED', 401);
    return `studio_session_${sha(token)}`;
  };
  const identity = (sid, key) => {
    if (!uuid.test(key ?? '')) throw new StudioPaymentError('INVALID_OPERATION_KEY');
    const suffix = sha(`${sid}:${key}`).slice(0, 32);
    return { operationId: `studio_op_${suffix}`, runId: `studio_run_${suffix}`,
      attemptId: `studio_attempt_${suffix}`, orderId: `studio_order_${suffix}` };
  };
  async function readRow(tx, sid, key, lock = false) {
    const result = await tx.query(`SELECT * FROM studio_payment_operations WHERE session_id=$1 AND operation_key=$2 ${lock ? 'FOR UPDATE' : ''}`, [sid, key]);
    return result.rows[0] ?? null;
  }
  async function applyEvent(tx, row, event) {
    if (event.operationId !== row.operation_id || event.attemptId !== row.attempt_id || event.provider !== 'synthetic'
      || event.livemode !== false) return 'ignored_identity_mismatch';
    const reduced = reduceSyntheticPaymentEvent({ current: row.provider_state, event });
    if (reduced.disposition === 'applied') {
      const state = reduced.state.status === 'succeeded' ? 'succeeded' : reduced.state.status === 'declined' ? 'declined' : 'unknown';
      const order = state === 'succeeded' ? 'confirmed' : state === 'declined' ? 'payment_failed' : 'pending_payment';
      await tx.query('UPDATE studio_payment_operations SET provider_state=$2::jsonb,status=$3,order_status=$4,updated_at=now() WHERE operation_id=$1',
        [row.operation_id, JSON.stringify(reduced.state), state, order]);
      await tx.query('UPDATE runs SET state=$2,updated_at=now() WHERE id=$1',
        [row.run_id, state === 'succeeded' ? 'succeeded' : state === 'declined' ? 'failed' : 'awaiting_payment']);
    }
    return reduced.disposition;
  }
  async function receive(sid, key, event, defer = false) {
    return persistence.withTransaction(async tx => {
      const row = await readRow(tx, sid, key, true);
      if (!row) throw new StudioPaymentError('OPERATION_NOT_FOUND', 404);
      if (event.operationId !== row.operation_id || event.attemptId !== row.attempt_id || event.provider !== 'synthetic'
        || event.livemode !== false) return 'ignored_identity_mismatch';
      await persistence.recordWebhookReceipt(tx, { provider: 'synthetic', providerEventId: event.providerEventId,
        type: event.type, livemode: false, providerCreatedAt: event.providerCreatedAt,
        receivedAt: new Date(now()).toISOString(), payloadSha256: sha(JSON.stringify(event)) });
      const inserted = await tx.query(`INSERT INTO studio_payment_receipts(provider_event_id,operation_id,attempt_id,safe_event)
        VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING provider_event_id`,
      [event.providerEventId, row.operation_id, row.attempt_id, JSON.stringify(event)]);
      if (!inserted.rowCount) return 'duplicate';
      if (defer) return 'pending';
      const disposition = await applyEvent(tx, row, event);
      await tx.query('UPDATE studio_payment_receipts SET applied=$2,disposition=$3,applied_at=now() WHERE provider_event_id=$1',
        [event.providerEventId, disposition === 'applied', disposition]);
      return disposition;
    });
  }
  async function read(token, key) {
    const sid = sessionId(token); identity(sid, key);
    const row = await readRow(pool, sid, key);
    if (!row) return null;
    const receipts = await pool.query(`SELECT count(*)::int AS recorded,
      count(*) FILTER (WHERE applied)::int AS applied FROM studio_payment_receipts WHERE operation_id=$1`, [row.operation_id]);
    return { ...publicRow(row), receipts: receipts.rows[0] };
  }
  async function start({ token, key, mission, productId, approvedQuoteHash, scenario }) {
    const sid = sessionId(token);
    const ids = identity(sid, key);
    if (!scenarios.has(scenario)) throw new StudioPaymentError('INVALID_SCENARIO');
    const terms = validateStudioMission(mission);
    const priced = requestStudioQuote({ productId, quantity: 1 }, terms);
    if (priced.outcome !== 'quoted') throw new StudioPaymentError('QUOTE_REFUSED', 409);
    const quote = priced.quote;
    const quoteHash = simulatedQuoteHash(quote);
    if (approvedQuoteHash !== quoteHash) throw new StudioPaymentError('EXACT_QUOTE_APPROVAL_REQUIRED', 403);
    const stamped = new Date(now()).toISOString();
    const tokenScope = issueSimulatedToken({ runId: ids.runId, approvalId: `studio_approval_${ids.runId}`, quote, issuedAt: stamped });
    const authority = authorizeSimulatedCheckout({ token: tokenScope, tokenState: 'issued', quote, runId: ids.runId,
      now: stamped, request: { tokenReference: tokenScope.tokenReference, runId: ids.runId, seller: quote.seller,
        currency: quote.currency, quoteId: quote.quoteId, quoteVersion: tokenScope.quoteVersion,
        quoteHash, amountMinor: quote.totalMinor } });
    if (!authority.ok) throw new StudioPaymentError(authority.reason, 403);
    const requestHash = sha(JSON.stringify([terms, productId, quoteHash, quote.totalMinor, scenario]));
    await pool.query(`INSERT INTO visitor_sessions(id,expires_at) VALUES($1,now()+interval '1 day')
      ON CONFLICT (id) DO NOTHING`, [sid]);
    await claimOperation({ persistence, claim: { sessionId: sid, scope: 'studio_simulated_payment', key, requestHash },
      createOperation: async tx => {
        await tx.query(`INSERT INTO runs(id,session_id,mode,scenario,state,reference_time,schema_version)
          VALUES($1,$2,'guided_replay','studio_durable_synthetic','awaiting_payment',$3,'studio-m5-v1')`,
        [ids.runId, sid, stamped]);
        const inserted = await tx.query(`INSERT INTO studio_payment_operations
          (operation_id,session_id,run_id,operation_key,request_hash,attempt_id,scenario,quote_hash,approval_id,token_scope,amount_minor,currency,order_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) RETURNING *`,
        [ids.operationId, sid, ids.runId, key, requestHash, ids.attemptId, scenario, quoteHash,
          tokenScope.approvalId, JSON.stringify(tokenScope), quote.totalMinor, quote.currency, ids.orderId]);
        return { operationId: ids.operationId, row: inserted.rows[0] };
      },
      readOperation: async tx => {
        const row = await readRow(tx, sid, key);
        return row && { operationId: row.operation_id, row };
      } });
    const fenced = await pool.query(`UPDATE studio_payment_operations SET status='dispatching',authority_state='consumed',dispatch_count=1,updated_at=now()
      WHERE operation_id=$1 AND status='reserved' AND authority_state='reserved' AND dispatch_count=0
        AND (token_scope->>'expiresAt')::timestamptz > now() RETURNING *`, [ids.operationId]);
    if (!fenced.rowCount) {
      await pool.query(`WITH expired AS (
        UPDATE studio_payment_operations SET status='expired',authority_state='expired',order_status='payment_failed',updated_at=now()
        WHERE operation_id=$1 AND status='reserved' AND authority_state='reserved'
          AND (token_scope->>'expiresAt')::timestamptz <= now() RETURNING run_id
      ) UPDATE runs SET state='expired',updated_at=now() WHERE id IN (SELECT run_id FROM expired)`, [ids.operationId]);
      return read(token, key);
    }
    const provider = providerFactory({ scenario });
    try {
      const result = await provider.execute({ operationId: ids.operationId, attemptId: ids.attemptId,
        idempotencyKey: ids.operationId, requestHash }, { onCallback: event => receive(sid, key, event, scenario === 'timeout_after_effect') });
      if (result.safeEvent && !['callback_before_response', 'duplicate_callback'].includes(scenario)) {
        await receive(sid, key, result.safeEvent);
      }
      if (result.status === 'requires_action') await pool.query(`UPDATE studio_payment_operations SET status='unknown' WHERE operation_id=$1 AND status='dispatching'`, [ids.operationId]);
    } catch (error) {
      if (!(error instanceof SyntheticProviderTimeoutError)) throw error;
      await pool.query(`UPDATE studio_payment_operations SET status='unknown',updated_at=now()
        WHERE operation_id=$1 AND status='dispatching'`, [ids.operationId]);
    }
    return read(token, key);
  }
  async function reconcile(token, key) {
    const sid = sessionId(token); identity(sid, key);
    await persistence.withTransaction(async tx => {
      const row = await readRow(tx, sid, key, true);
      if (!row) throw new StudioPaymentError('OPERATION_NOT_FOUND', 404);
      if (row.status !== 'unknown' && row.status !== 'dispatching') return publicRow(row);
      const receipt = await tx.query(`SELECT * FROM studio_payment_receipts WHERE operation_id=$1 AND applied=false
        ORDER BY received_at,provider_event_id LIMIT 1 FOR UPDATE`, [row.operation_id]);
      if (!receipt.rows[0]) {
        if (row.status === 'dispatching') await tx.query(`UPDATE studio_payment_operations SET status='unknown',updated_at=now() WHERE operation_id=$1`, [row.operation_id]);
        return publicRow({ ...row, status: 'unknown' });
      }
      const event = receipt.rows[0].safe_event;
      const disposition = await applyEvent(tx, row, event);
      await tx.query('UPDATE studio_payment_receipts SET applied=$2,disposition=$3,applied_at=now() WHERE provider_event_id=$1',
        [event.providerEventId, disposition === 'applied', disposition]);
    });
    return read(token, key);
  }
  return Object.freeze({ start, read, reconcile });
}
