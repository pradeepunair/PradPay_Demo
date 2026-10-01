import { start } from "workflow/api";
import { syntheticSuccessWorkflow } from "../../../../workflows/synthetic-success-v1.js";
import { createSyntheticWorkflowStartPost } from "../../../../lib/workflows/synthetic-start.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createSyntheticWorkflowStartPost({
  startWorkflow: (input) => start(syntheticSuccessWorkflow, [input]),
});
