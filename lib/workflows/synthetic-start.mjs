const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

function json(body, status) {
  return Response.json(body, { status, headers: responseHeaders });
}

function validInput(input) {
  return input
    && input.kind === "synthetic-checkout"
    && typeof input.reference === "string"
    && /^[a-zA-Z0-9._:-]{1,128}$/.test(input.reference);
}

export function createSyntheticWorkflowStartPost(options = {}) {
  const { startWorkflow, effectGuard } = options;
  const workflowEnabled = options.workflowEnabled ?? (() => process.env.PAYMENTLAB_WORKFLOW_ENABLED === "true");
  const requireGuard = true;
  if (typeof startWorkflow !== "function") throw new TypeError("A workflow starter is required.");

  return async function syntheticWorkflowStartPost(request) {
    if (!workflowEnabled()) {
      return json({ code: "WORKFLOW_DISABLED", message: "Workflow capability is disabled." }, 503);
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return json({ code: "INVALID_JSON", message: "Request body must be valid JSON." }, 400);
    }
    if (!validInput(input)) {
      return json({ code: "INVALID_INPUT", message: "Synthetic workflow input is invalid." }, 400);
    }

    let run;
    if (!requireGuard || effectGuard) {
      try {
        run = effectGuard ? await effectGuard.run("workflow", () => startWorkflow(input)) : await startWorkflow(input);
      } catch (error) {
        if (error?.code === "EFFECT_GUARD_DENIED" || error?.code === "EFFECT_OBSERVER_REQUIRED") {
          return json({ code: error.code, message: error.message }, 503);
        }
        throw error;
      }
    } else {
      return json({ code: "EFFECT_GUARD_REQUIRED", message: "Workflow effect capability is denied." }, 503);
    }
    return json({
      accepted: true,
      workflow: "synthetic-success-v1",
      runId: run?.runId ?? null,
    }, 202);
  };
}
