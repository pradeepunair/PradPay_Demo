import { handleAcpRoute } from "../../../../../../lib/application/acp-runtime.mjs";
import { createLocalEffectGuardFromEnv } from "../../../../../../lib/sandbox/effect-guard.mjs";

function effectGuard() {
  return createLocalEffectGuardFromEnv({ observer: { record() {} } });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, context) {
  const params = await context.params;
  return handleAcpRoute(request, {
    operation: "complete",
    checkoutSessionId: params.checkoutSessionId,
  }, { effectGuard: effectGuard() });
}
