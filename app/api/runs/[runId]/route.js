import { createLocalRunHandlers } from "../../../../lib/composition/local-run-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createLocalRunHandlers();
export async function GET(request, context) {
  const { runId } = await context.params;
  return handler.readRun(request, runId);
}
