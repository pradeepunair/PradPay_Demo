import { createLocalJourneyHandlers } from "../../../../../lib/demo/local-journey-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request, { params }) {
  return createLocalJourneyHandlers().approve(request, (await params).id);
}
