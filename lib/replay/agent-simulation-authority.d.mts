export const SIMULATED_QUOTE_VERSION: 1;
export const SIMULATED_TOKEN_TTL_MS: number;
export interface SimulatedQuote {
  quoteId: string; productId: string; seller: string; productMinor: number;
  discountMinor: number; shippingMinor: number; taxMinor: number;
  totalMinor: number; currency: string;
}
export interface SimulatedToken {
  tokenReference: string; runId: string; approvalId: string; maxUses: 1; quoteId: string;
  quoteVersion: 1; quoteHash: string; seller: string; amountMinor: number;
  currency: string; issuedAt: string; expiresAt: string;
}
export interface SimulatedCheckoutRequest {
  tokenReference: string; runId: string; quoteId: string; quoteVersion: number;
  quoteHash: string; seller: string; amountMinor: number; currency: string;
}
export function simulatedQuoteHash(quote: SimulatedQuote): string;
export function issueSimulatedToken(input: { runId: string; approvalId: string;
  quote: SimulatedQuote; issuedAt: string }): SimulatedToken;
export function authorizeSimulatedCheckout(input: { token: SimulatedToken | null;
  tokenState: string; request: SimulatedCheckoutRequest; quote: SimulatedQuote;
  runId: string; now: string }): { ok: boolean; reason: string | null };
