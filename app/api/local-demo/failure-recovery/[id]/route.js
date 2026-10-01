import { createFailureRecoveryHandlers } from "../../../../../lib/demo/failure-recovery-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request, { params }) {
  return createFailureRecoveryHandlers().read(request, (await params).id);
}
