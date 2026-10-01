import { createLocalRunHandlers } from "../../../lib/composition/local-run-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createLocalRunHandlers().createRun;
