export const SAFE_EXECUTION_FAILURE_MESSAGE = "Capability operation stopped safely; no retry is authorized.";

export function sanitizeExecutionFailure(_error) {
  return new Error(SAFE_EXECUTION_FAILURE_MESSAGE);
}
