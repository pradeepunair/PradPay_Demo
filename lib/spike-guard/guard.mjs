import { homedir } from "node:os";
import { join } from "node:path";
import { FROZEN_REQUEST_HASH } from "./request.mjs";

export const CANONICAL_SPIKE_STATE_DIRECTORY = join(
  homedir(),
  ".paymentlab",
  "m3-stripe-spike-guard",
  FROZEN_REQUEST_HASH,
);

export const SPIKE_EXECUTION_DISABLED_MESSAGE =
  "Stripe capability execution is disabled pending verified owner authorization.";

/**
 * Deliberate fail-closed boundary. Product has not approved a signer trust root,
 * authenticated operator identity source, or protected receipt-consumption store.
 * Never inspect caller fields or invoke credential/provider callbacks here.
 */
export async function executeApprovedStripeCapabilitySpike(_input) {
  throw new Error(SPIKE_EXECUTION_DISABLED_MESSAGE);
}
