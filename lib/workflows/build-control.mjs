import { existsSync } from "node:fs";
import path from "node:path";

const BUILD_MODE_ENV = "PAYMENTLAB_WORKFLOW_BUILD_MODE";
const ALLOWED_MODES = new Set(["local-synthetic", "protected-deny"]);

export const WORKFLOW_BUILD_MODE_ENV = BUILD_MODE_ENV;
export const WORKFLOW_BUILD_MODES = Object.freeze({
  LOCAL_SYNTHETIC: "local-synthetic",
  PROTECTED_DENY: "protected-deny",
});

export function resolveWorkflowBuildControl(env = process.env) {
  const raw = env?.[BUILD_MODE_ENV];
  if (typeof raw !== "string" || raw.length === 0 || !ALLOWED_MODES.has(raw)) {
    throw new Error(`Invalid ${BUILD_MODE_ENV}; expected local-synthetic or protected-deny.`);
  }
  return Object.freeze({ mode: raw, composeWorkflow: raw === "local-synthetic" });
}

export function isWorkflowBuildMode(value) {
  return typeof value === "string" && ALLOWED_MODES.has(value);
}

// Workflow generates ignored source routes during a local build. Disabling the
// plugin does not remove them; Next would still compile them on a later build.
export function assertProtectedSourceIsClean(control, root) {
  if (control.mode !== WORKFLOW_BUILD_MODES.PROTECTED_DENY) return;
  if (["app", "src/app"].some((directory) => existsSync(path.join(root, directory, ".well-known/workflow")))) {
    throw new Error("Protected build requires a clean source checkout without generated .well-known/workflow routes. Move the generated routes out of the app directory and rebuild with a fresh .next directory.");
  }
}
