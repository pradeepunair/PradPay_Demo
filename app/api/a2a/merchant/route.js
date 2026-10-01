import { A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";

import { createMerchantA2A } from "../../../../lib/a2a/merchant.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let active;
function localRequest(request) {
  const url = new URL(request.url);
  return process.env.PAYMENTLAB_RUN_API_MODE === "local" && process.env.PAYMENTLAB_ENVIRONMENT === "local"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export async function POST(request) {
  if (!localRequest(request)) return new Response(null, { status: 404 });
  if (request.headers.get("a2a-version") !== A2A_PROTOCOL_VERSION) {
    return Response.json({ code: "A2A_VERSION_REQUIRED" }, { status: 400 });
  }
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return Response.json({ code: "JSON_REQUIRED" }, { status: 415 });
  }
  const body = await request.text();
  if (body.length > 4096) return Response.json({ code: "REQUEST_TOO_LARGE" }, { status: 413 });
  const origin = new URL(request.url).origin;
  if (!active || active.origin !== origin) active = { origin, ...createMerchantA2A(origin) };
  const result = await active.transport.handle(body, new ServerCallContext({ requestedVersion: A2A_PROTOCOL_VERSION }));
  if (result && typeof result[Symbol.asyncIterator] === "function") {
    return Response.json({ code: "STREAMING_UNSUPPORTED" }, { status: 501 });
  }
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
