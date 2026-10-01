import { parseSandboxConfiguration } from "./readiness.mjs";

const EFFECTS = new Set(["acp", "workflow", "stripe-webhook", "hosted-nonce"]);

export class EffectGuardDeniedError extends Error {
  constructor(code = "EFFECT_GUARD_DENIED") {
    super("Effect capability is denied by the local guard.");
    this.name = "EffectGuardDeniedError";
    this.code = code;
  }
}

function validateObserver(observer) {
  return observer && typeof observer.record === "function" ? observer : null;
}

function record(observer, effect, decision) {
  try {
    observer?.record(Object.freeze({
      schemaVersion: "effect-guard-event.v1",
      effect,
      decision,
    }));
  } catch {
    throw new EffectGuardDeniedError("EFFECT_OBSERVER_UNAVAILABLE");
  }
}

export function createRedactedEffectObserver(recordEvent) {
  if (typeof recordEvent !== "function") throw new TypeError("effect observer callback is required");
  return Object.freeze({
    record(event) {
      if (!event || event.schemaVersion !== "effect-guard-event.v1"
        || !EFFECTS.has(event.effect)
        || !["allow", "deny"].includes(event.decision)
        || Object.keys(event).some((key) => !["schemaVersion", "effect", "decision"].includes(key))) {
        throw new TypeError("effect observer event is not redacted");
      }
      recordEvent(event);
    },
  });
}

export function createLocalEffectGuard({
  env,
  authorized = false,
  enabled = false,
  observer,
} = {}) {
  const safeObserver = validateObserver(observer);
  let config;
  try {
    config = parseSandboxConfiguration(env);
  } catch {
    config = null;
  }
  const localSynthetic = config?.environment === "local"
    && config.databaseMode === "local"
    && config.callbackMode === "local-synthetic"
    && config.workerMode === "local-synthetic";

  return Object.freeze({
    assertAllowed(effect) {
      if (!EFFECTS.has(effect)) throw new EffectGuardDeniedError("UNKNOWN_EFFECT");
      const permitted = Boolean(safeObserver && authorized === true && enabled === true && localSynthetic);
      if (!safeObserver) throw new EffectGuardDeniedError("EFFECT_OBSERVER_REQUIRED");
      record(safeObserver, effect, permitted ? "allow" : "deny");
      if (!permitted) throw new EffectGuardDeniedError();
    },
    async run(effect, callback) {
      if (typeof callback !== "function") throw new TypeError("effect callback is required");
      this.assertAllowed(effect);
      return callback();
    },
  });
}

export function createLocalEffectGuardFromEnv({ observer, authorized, enabled } = {}) {
  return createLocalEffectGuard({
    env: {
      PAYMENTLAB_ENVIRONMENT: process.env.PAYMENTLAB_ENVIRONMENT,
      PAYMENTLAB_DATABASE_MODE: process.env.PAYMENTLAB_DATABASE_MODE,
      PAYMENTLAB_CALLBACK_MODE: process.env.PAYMENTLAB_CALLBACK_MODE,
      PAYMENTLAB_WORKER_MODE: process.env.PAYMENTLAB_WORKER_MODE,
    },
    authorized: authorized ?? process.env.PAYMENTLAB_EFFECT_GUARD_AUTHORIZED === "true",
    enabled: enabled ?? process.env.PAYMENTLAB_EFFECT_GUARD_ENABLED === "true",
    observer,
  });
}
