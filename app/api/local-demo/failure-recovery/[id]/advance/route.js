import { createFailureRecoveryHandlers } from "../../../../../../lib/demo/failure-recovery-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request, { params }) {
  return createFailureRecoveryHandlers().advance(request, (await params).id);
}
