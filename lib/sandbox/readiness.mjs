const REQUIRED_KEYS = Object.freeze([
  "PAYMENTLAB_ENVIRONMENT",
  "PAYMENTLAB_DATABASE_MODE",
  "PAYMENTLAB_CALLBACK_MODE",
  "PAYMENTLAB_WORKER_MODE",
]);

const VALID = Object.freeze({
  PAYMENTLAB_ENVIRONMENT: new Set(["local", "staging"]),
  PAYMENTLAB_DATABASE_MODE: new Set(["local", "hosted"]),
  PAYMENTLAB_CALLBACK_MODE: new Set(["disabled", "local-synthetic", "hosted"]),
  PAYMENTLAB_WORKER_MODE: new Set(["disabled", "local-synthetic", "hosted"]),
});

const FORBIDDEN_ENV_KEYS = /^(STRIPE_|PAYMENT_PROVIDER_|NEXT_PUBLIC_.*(KEY|SECRET|TOKEN)|.*(SECRET|TOKEN|PASSWORD|CREDENTIAL).*)$/i;

export class SandboxConfigurationError extends Error {
  constructor(code) {
    super("Sandbox readiness configuration is invalid.");
    this.name = "SandboxConfigurationError";
    this.code = code;
  }
}

function redactAndValidateInput(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new SandboxConfigurationError("INVALID_ENV_OBJECT");
  const allowed = new Set(REQUIRED_KEYS);
  for (const key of Object.keys(env)) {
    if (!allowed.has(key)) {
      if (FORBIDDEN_ENV_KEYS.test(key)) throw new SandboxConfigurationError("FORBIDDEN_SECRET_OR_PROVIDER_SETTING");
      throw new SandboxConfigurationError("UNSUPPORTED_SETTING");
    }
  }
}

export function parseSandboxConfiguration(env) {
  redactAndValidateInput(env);
  const missing = REQUIRED_KEYS.filter((key) => typeof env[key] !== "string" || env[key].trim() === "");
  if (missing.length) throw new SandboxConfigurationError("MISSING_REQUIRED_SETTING");

  for (const key of REQUIRED_KEYS) {
    if (!VALID[key].has(env[key])) throw new SandboxConfigurationError("UNSUPPORTED_SETTING");
  }

  const config = {
    environment: env.PAYMENTLAB_ENVIRONMENT,
    databaseMode: env.PAYMENTLAB_DATABASE_MODE,
    callbackMode: env.PAYMENTLAB_CALLBACK_MODE,
    workerMode: env.PAYMENTLAB_WORKER_MODE,
  };

  if (config.environment === "local"
    && (config.databaseMode !== "local" || config.callbackMode === "hosted" || config.workerMode === "hosted")) {
    throw new SandboxConfigurationError("LOCAL_HOSTED_MIX_NOT_ALLOWED");
  }
  if (config.environment === "staging"
    && (config.databaseMode !== "hosted" || config.callbackMode !== "hosted" || config.workerMode !== "hosted")) {
    throw new SandboxConfigurationError("STAGING_REQUIRES_HOSTED_PREREQUISITES");
  }

  return Object.freeze(config);
}

export function assessSandboxReadiness({ config, prerequisites } = {}) {
  if (!config || typeof config !== "object" || !Object.isFrozen(config)) {
    throw new SandboxConfigurationError("CONFIGURATION_NOT_VALIDATED");
  }
  if (!prerequisites || typeof prerequisites !== "object" || Array.isArray(prerequisites)) {
    throw new SandboxConfigurationError("PREREQUISITES_REQUIRED");
  }

  const checks = Object.freeze({
    database: config.databaseMode === "local" || prerequisites.database === "ready",
    callback: config.callbackMode === "disabled" || config.callbackMode === "local-synthetic"
      || prerequisites.callback === "ready",
    worker: config.workerMode === "disabled" || config.workerMode === "local-synthetic"
      || prerequisites.worker === "ready",
  });
  const status = Object.values(checks).every(Boolean) ? "READY" : "BLOCKED";
  const reasons = Object.freeze(Object.entries(checks)
    .filter(([, ready]) => !ready)
    .map(([name]) => `${name.toUpperCase()}_PREREQUISITE_NOT_READY`));
  return Object.freeze({ status, checks, reasons });
}

export function createSandboxReadinessSnapshot({ env, prerequisites = {} } = {}) {
  const config = parseSandboxConfiguration(env);
  const readiness = assessSandboxReadiness({ config, prerequisites });
  return Object.freeze({
    schemaVersion: "sandbox-readiness.v1",
    status: readiness.status,
    modes: Object.freeze({
      environment: config.environment,
      database: config.databaseMode,
      callback: config.callbackMode,
      worker: config.workerMode,
    }),
    checks: readiness.checks,
    reasons: readiness.reasons,
    effects: Object.freeze({
      externalProviderCalls: 0,
      payments: 0,
      nonceUses: 0,
      replayVerified: false,
    }),
  });
}

export const REQUIRED_SANDBOX_SETTINGS = REQUIRED_KEYS;
