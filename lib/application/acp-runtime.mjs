import {
  RuntimeError,
  createAcpRuntimeHandler,
  createServerHeldAuthenticator,
} from "../acp/runtime/index.mjs";

import { EffectGuardDeniedError } from "../sandbox/effect-guard.mjs";

let applicationPort = null;

const unavailablePort = new Proxy({}, {
  get() {
    return async () => { throw new RuntimeError("service_unavailable"); };
  },
});

function enabled(value) {
  return value === "true";
}

function allowedOrigins(value) {
  const origins = [];
  for (const candidate of (value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean)) {
    try {
      const parsed = new URL(candidate);
      if (["http:", "https:"].includes(parsed.protocol) && parsed.origin !== "null") origins.push(parsed.origin);
    } catch {
      // Invalid entries are ignored so origin admission fails closed.
    }
  }
  return [...new Set(origins)];
}

export function configureAcpRuntimePort(port) {
  if (!port || typeof port !== "object") throw new TypeError("ACP runtime port must be an object");
  applicationPort = port;
}

export function resetAcpRuntimePort() {
  applicationPort = null;
}

export async function handleAcpRoute(request, route, { effectGuard } = {}) {
  if (!effectGuard || typeof effectGuard.assertAllowed !== "function") {
    return Response.json({ code: "EFFECT_GUARD_REQUIRED", message: "ACP effect capability requires an injected guard." }, { status: 503 });
  }
  try {
    effectGuard.assertAllowed("acp");
  } catch (error) {
      if (error instanceof EffectGuardDeniedError) {
        return Response.json({ code: error.code, message: error.message }, { status: 503 });
      }
      throw error;
  }
  const sessionId = process.env.ACP_RUNTIME_SESSION_ID ?? "";
  const runIds = (process.env.ACP_RUNTIME_RUN_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const handler = createAcpRuntimeHandler({
    port: applicationPort ?? unavailablePort,
    authenticate: createServerHeldAuthenticator({
      token: process.env.ACP_RUNTIME_BEARER_TOKEN ?? "",
      subject: process.env.ACP_RUNTIME_SUBJECT ?? "acp-service",
      sessionId,
      runIds,
    }),
    flags: {
      admission: enabled(process.env.ACP_RUNTIME_ADMISSION_ENABLED),
      complete: enabled(process.env.ACP_COMPLETE_ENABLED),
      delegatePayment: enabled(process.env.ACP_DELEGATE_PAYMENT_ENABLED),
    },
    allowedOrigins: allowedOrigins(process.env.ACP_ALLOWED_ORIGINS),
  });
  return handler(request, route);
}
