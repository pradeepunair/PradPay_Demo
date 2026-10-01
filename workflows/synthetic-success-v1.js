export const SYNTHETIC_WORKFLOW_NAME = "synthetic-success-v1";
export const SYNTHETIC_WORKFLOW_VERSION = "1";

export async function syntheticSuccessWorkflow(input) {
  "use workflow";

  return syntheticCompletionStep(input);
}

export async function syntheticCompletionStep(input) {
  "use step";

  if (!input || input.kind !== "synthetic-checkout") {
    throw new Error("Synthetic workflow input is invalid.");
  }

  return {
    workflow: SYNTHETIC_WORKFLOW_NAME,
    version: SYNTHETIC_WORKFLOW_VERSION,
    status: "completed",
    outcome: "synthetic-success",
    reference: input.reference,
  };
}
