import { createSyntheticPaymentProvider } from "../payments/synthetic-provider.mjs";
import { assessSandboxReadiness, parseSandboxConfiguration } from "./readiness.mjs";

const SMOKE_IDENTITY = Object.freeze({
  operationId: "m3_sandbox_smoke_operation",
  attemptId: "m3_sandbox_smoke_attempt",
  idempotencyKey: "m3_sandbox_smoke_idempotency",
  requestHash: "8f".repeat(32),
});

export async function runSyntheticSandboxSmoke({ env, prerequisites = {} } = {}) {
  const config = parseSandboxConfiguration(env);
  const readiness = assessSandboxReadiness({ config, prerequisites });
  if (readiness.status !== "READY") {
    return Object.freeze({ status: "BLOCKED", readiness, syntheticEffects: 0, providerCalls: 0 });
  }
  if (config.environment !== "local" || config.databaseMode !== "local"
    || !["local-synthetic", "disabled"].includes(config.callbackMode)
    || !["local-synthetic", "disabled"].includes(config.workerMode)) {
    return Object.freeze({ status: "BLOCKED", readiness, syntheticEffects: 0, providerCalls: 0 });
  }

  const provider = createSyntheticPaymentProvider({ scenario: "succeeded" });
  const first = await provider.execute(SMOKE_IDENTITY);
  const replay = await provider.execute(SMOKE_IDENTITY);
  const counts = provider.inspect();
  const passed = first.status === "succeeded"
    && replay.status === "succeeded"
    && replay.replay === true
    && counts.calls === 2
    && counts.effects === 1
    && counts.operations === 1;

  return Object.freeze({
    status: passed ? "PASS" : "FAIL",
    readiness,
    syntheticEffects: counts.effects,
    providerCalls: counts.calls,
    replayVerified: replay.replay,
    externalProviderCalls: 0,
    payments: 0,
  });
}
