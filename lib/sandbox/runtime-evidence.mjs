const CHECK_NAMES = Object.freeze(["build", "database", "callback", "worker", "migration", "killSwitch"]);
const STATES = new Set(["ready", "blocked", "unknown"]);
const SAFE_REASONS = new Set([
  "BUILD_CHECK_FAILED",
  "DATABASE_CHECK_FAILED",
  "CALLBACK_CHECK_FAILED",
  "WORKER_CHECK_FAILED",
  "MIGRATION_CHECK_FAILED",
  "KILL_SWITCH_CHECK_FAILED",
  "PROBE_UNAVAILABLE",
]);
const SHA = /^[a-f0-9]{40}$/;
const validatedEvidence = new WeakSet();

export class RuntimeEvidenceError extends Error {
  constructor(code) {
    super("Runtime evidence is invalid.");
    this.name = "RuntimeEvidenceError";
    this.code = code;
  }
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getOwnDataProperties(value, allowedKeys, errorCode) {
  if (!isRecord(value)) throw new RuntimeEvidenceError(errorCode);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
    throw new RuntimeEvidenceError(errorCode);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const properties = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) throw new RuntimeEvidenceError(errorCode);
    properties[key] = descriptor.value;
  }
  return properties;
}

function validateCheck(check) {
  const values = getOwnDataProperties(check, new Set(["status", "reason"]), "UNSAFE_CHECK_FIELDS");
  if (!STATES.has(values.status)) throw new RuntimeEvidenceError("INVALID_CHECK_STATUS");
  if (Object.hasOwn(values, "reason") && !SAFE_REASONS.has(values.reason)) {
    throw new RuntimeEvidenceError("UNSAFE_CHECK_REASON");
  }
  return Object.freeze({
    status: values.status,
    ...(Object.hasOwn(values, "reason") ? { reason: values.reason } : {}),
  });
}

export function createRuntimeEvidence({ commit, environment, checks, generatedAt }) {
  if (typeof commit !== "string" || !SHA.test(commit)) throw new RuntimeEvidenceError("INVALID_COMMIT");
  if (environment !== "staging" && environment !== "local") throw new RuntimeEvidenceError("INVALID_ENVIRONMENT");
  if (typeof generatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(generatedAt)
    || Number.isNaN(Date.parse(generatedAt))) throw new RuntimeEvidenceError("INVALID_TIMESTAMP");

  const suppliedChecks = getOwnDataProperties(checks, new Set(CHECK_NAMES), "INCOMPLETE_CHECKS");
  if (Object.keys(suppliedChecks).length !== CHECK_NAMES.length
    || CHECK_NAMES.some((name) => !Object.hasOwn(suppliedChecks, name))) {
    throw new RuntimeEvidenceError("INCOMPLETE_CHECKS");
  }

  const safeChecks = Object.freeze(Object.fromEntries(
    CHECK_NAMES.map((name) => [name, validateCheck(suppliedChecks[name])]),
  ));
  const ready = Object.values(safeChecks).every(({ status }) => status === "ready");
  const evidence = Object.freeze({
    schemaVersion: 1,
    commit,
    environment,
    generatedAt,
    status: ready ? "READY" : "BLOCKED",
    checks: safeChecks,
  });
  validatedEvidence.add(evidence);
  return evidence;
}

export function summarizeRuntimeEvidence(evidence) {
  if (!evidence || !validatedEvidence.has(evidence)) {
    throw new RuntimeEvidenceError("UNVALIDATED_EVIDENCE");
  }
  return Object.freeze({
    event: "sandbox.runtime_readiness",
    status: evidence.status,
    environment: evidence.environment,
    commit: evidence.commit,
    checkCounts: Object.freeze(Object.fromEntries(["ready", "blocked", "unknown"].map((state) => [
      state,
      Object.values(evidence.checks).filter((check) => check.status === state).length,
    ]))),
  });
}

export const RUNTIME_CHECKS = CHECK_NAMES;
