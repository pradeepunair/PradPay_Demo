import { createMerchantAgentCard } from "../../../lib/a2a/merchant.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request) {
  const url = new URL(request.url);
  if (process.env.PAYMENTLAB_RUN_API_MODE !== "local" || process.env.PAYMENTLAB_ENVIRONMENT !== "local"
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return new Response(null, { status: 404 });
  }
  return Response.json(createMerchantAgentCard(url.origin), { headers: { "Cache-Control": "no-store" } });
}
