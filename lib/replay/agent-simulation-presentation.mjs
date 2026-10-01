// Presentation-only routing. These positions never authorize or dispatch a payment.
export const STUDIO_PARTICIPANTS = Object.freeze([
  { id: 'Buyer', label: 'Buyer' },
  { id: 'Atlas', label: 'Atlas' },
  { id: 'Wallet', label: 'Demo wallet' },
  { id: 'Seller agent', label: 'Seller agent' },
  { id: 'Seller backend', label: 'Seller backend' },
  { id: 'Payment simulator', label: 'Payment simulator' },
]);

export function presentEventRoute(event) {
  if (!event) return { kind: 'idle', sender: null, receiver: null, from: 0, to: 0 };
  if (event.actor === 'Simulation') {
    return { kind: 'system', sender: 'Simulation', receiver: event.recipient, from: null,
      to: STUDIO_PARTICIPANTS.findIndex(participant => participant.id === event.recipient) * 20 };
  }
  const from = STUDIO_PARTICIPANTS.findIndex(participant => participant.id === event.actor);
  const to = STUDIO_PARTICIPANTS.findIndex(participant => participant.id === event.recipient);
  if (from < 0 || to < 0 || from === to) throw new Error(`Unsupported Studio presentation route: ${event.type}`);
  return { kind: 'message', sender: event.actor, receiver: event.recipient, from: from * 20, to: to * 20 };
}

export function replayPhase(event) {
  if (!event) return 0;
  if (['seller.quote_refused', 'buyer.purchase_declined', 'seller.checkout_denied',
    'provider.response_lost', 'provider.callback_verified', 'seller.order_confirmed'].includes(event.type)) return 5;
  if (['seller.payment_requested', 'provider.response_received',
    'seller.attempt_reserved'].includes(event.type)) return 4;
  if (['buyer.purchase_approved', 'agent.token_requested', 'wallet.token_issued',
    'buyer.token_revoked', 'simulation.clock_advanced', 'agent.checkout_requested'].includes(event.type)) return 3;
  if (['agent.quote_requested', 'seller.quote_returned'].includes(event.type)) return 2;
  if (['agent.catalog_requested', 'seller.catalog_returned', 'buyer.product_selected'].includes(event.type)) return 1;
  return 0;
}
