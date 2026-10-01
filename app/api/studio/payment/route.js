import { Pool } from 'pg';
import { createStudioPaymentService, studioPaymentConfiguration, StudioPaymentError } from '../../../../lib/replay/agent-simulation-durable.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
let pool;
function service(request) {
  const host = request.headers.get('host')?.split(':')[0];
  const origin = request.headers.get('origin');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host) || !studioPaymentConfiguration()) {
    throw new StudioPaymentError('STUDIO_DURABLE_DISABLED', 503);
  }
  if (origin && new URL(origin).host !== request.headers.get('host')) {
    throw new StudioPaymentError('STUDIO_ORIGIN_DENIED', 403);
  }
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 4, idleTimeoutMillis: 10_000 });
  return createStudioPaymentService({ pool });
}
function response(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
function failure(error) {
  if (error instanceof StudioPaymentError || error?.code === 'IDEMPOTENCY_CONFLICT') {
    return response({ error: error.code }, error.status ?? 409);
  }
  if (error?.code === '23505' && error?.constraint === 'studio_payment_one_unresolved_session_idx') {
    return response({ error: 'UNRESOLVED_OPERATION' }, 409);
  }
  console.error('Studio durable payment failed:', error?.code ?? error?.name ?? 'unknown');
  return response({ error: 'STUDIO_DURABLE_UNAVAILABLE' }, 503);
}
export async function POST(request) {
  try {
    const body = await request.json();
    if (body?.action === 'read') return response({ operation: await service(request).read(body.token, body.key) });
    if (body?.action === 'start') return response({ operation: await service(request).start(body) });
    if (body?.action === 'reconcile') return response({ operation: await service(request).reconcile(body.token, body.key) });
    return response({ error: 'INVALID_ACTION' }, 400);
  } catch (error) { return failure(error); }
}
