export const HUMAN_CAPABILITY_ID = "M3-STRIPE-HUMAN-CAP-001";
export const HUMAN_CAPABILITY_DISABLED_MESSAGE = "Automated Stripe capability remains disabled; use the local/fake two-phase approval boundary only.";

// Historical effect-capable human boundary. This export is deliberately inert:
// it rejects before inspecting caller adapters, fixture requests, credentials,
// nonce stores, or provider callbacks. The local/fake two-phase approval helper
// lives in jit-human-capability.mjs and has no effect-capable callback path.
export function createHumanCapabilityBoundary() {
  return Object.freeze({
    async execute() {
      throw new Error(HUMAN_CAPABILITY_DISABLED_MESSAGE);
    },
  });
}

export function assertAutomatedCapabilityStillDisabled() {
  throw new Error(HUMAN_CAPABILITY_DISABLED_MESSAGE);
}
