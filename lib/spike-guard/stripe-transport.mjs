export const STRIPE_TRANSPORT_DISABLED_MESSAGE =
  "Stripe provider transport is disabled pending verified owner authorization.";

/**
 * No network-capable implementation is present until Product/Security approve
 * owner-verification trust anchors. Supplied callbacks are intentionally ignored.
 */
export function createStripeGrantedTokenTransport(_options = {}) {
  return async function sendGrantedTokenRequest(_input = {}) {
    throw new Error(STRIPE_TRANSPORT_DISABLED_MESSAGE);
  };
}

export const sendApprovedStripeGrantedTokenRequest = createStripeGrantedTokenTransport();
// Provider request dispatch is intentionally unavailable.
