import { suggestStudioProduct, LocalSelectionError } from '../../../../lib/replay/agent-studio-local-selection.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const reply = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store' },
});

export async function POST(request) {
  const host = request.headers.get('host');
  const hostname = host?.split(':')[0];
  const origin = request.headers.get('origin');
  if (process.env.PAYMENTLAB_ENVIRONMENT !== 'local'
    || process.env.PAYMENTLAB_STUDIO_LOCAL_MODEL_ENABLE !== '1'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    return reply({ error: 'LOCAL_SELECTION_DISABLED' }, 503);
  }
  try {
    if (origin && new URL(origin).host !== host) return reply({ error: 'STUDIO_ORIGIN_DENIED' }, 403);
  } catch { return reply({ error: 'STUDIO_ORIGIN_DENIED' }, 403); }
  try {
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 2048) return reply({ error: 'REQUEST_TOO_LARGE' }, 413);
    const raw = await request.text();
    if (raw.length > 2048) return reply({ error: 'REQUEST_TOO_LARGE' }, 413);
    const body = JSON.parse(raw);
    return reply(await suggestStudioProduct(body?.mission));
  } catch (error) {
    if (error instanceof LocalSelectionError) return reply({ error: error.code }, error.status);
    if (error instanceof SyntaxError) return reply({ error: 'INVALID_JSON' }, 400);
    return reply({ error: 'LOCAL_MODEL_UNAVAILABLE' }, 503);
  }
}
