import { createSandboxReadinessSnapshot, SandboxConfigurationError } from "../../../../lib/sandbox/readiness.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTH_HEADER = "x-paymentlab-readiness-auth";
const CONTENT_TYPE = "application/vnd.paymentlab.sandbox-readiness.v1+json";

function errorResponse(code, status) {
  return Response.json({ schemaVersion: "sandbox-readiness.v1", code }, {
    status,
    headers: { "content-type": CONTENT_TYPE, "cache-control": "no-store" },
  });
}

export async function GET(request) {
  const expected = process.env.PAYMENTLAB_READINESS_AUTH;
  const supplied = request.headers.get(AUTH_HEADER);
  if (typeof expected !== "string" || expected.length === 0 || supplied !== expected) {
    return errorResponse("READINESS_AUTH_REQUIRED", 404);
  }

  try {
    const snapshot = createSandboxReadinessSnapshot({
      env: {
        PAYMENTLAB_ENVIRONMENT: process.env.PAYMENTLAB_ENVIRONMENT,
        PAYMENTLAB_DATABASE_MODE: process.env.PAYMENTLAB_DATABASE_MODE,
        PAYMENTLAB_CALLBACK_MODE: process.env.PAYMENTLAB_CALLBACK_MODE,
        PAYMENTLAB_WORKER_MODE: process.env.PAYMENTLAB_WORKER_MODE,
      },
      prerequisites: {
        database: process.env.PAYMENTLAB_DATABASE_PREREQUISITE,
        callback: process.env.PAYMENTLAB_CALLBACK_PREREQUISITE,
        worker: process.env.PAYMENTLAB_WORKER_PREREQUISITE,
      },
    });
    return Response.json(snapshot, {
      status: 200,
      headers: { "content-type": CONTENT_TYPE, "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SandboxConfigurationError) return errorResponse(error.code, 400);
    return errorResponse("READINESS_UNAVAILABLE", 503);
  }
}
