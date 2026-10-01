// Deterministic teaching-only authority. This fingerprint is not a signature,
// bearer credential, Stripe token or production security control.
export const SIMULATED_QUOTE_VERSION = 1;
export const SIMULATED_TOKEN_TTL_MS = 60_000;

const fingerprint = (value) => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `sim_hash_${hash.toString(16).padStart(16, "0")}`;
};

export function simulatedQuoteHash(quote) {
  return fingerprint(JSON.stringify([
    SIMULATED_QUOTE_VERSION, quote.quoteId, quote.productId, quote.seller,
    quote.productMinor, quote.discountMinor, quote.shippingMinor, quote.taxMinor,
    quote.totalMinor, quote.currency,
  ]));
}

export function issueSimulatedToken({ runId, approvalId, quote, issuedAt }) {
  const issuedMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMs)) throw new Error("INVALID_SIMULATION_TIME");
  return {
    tokenReference: "sim_token_01", runId, approvalId, maxUses: 1, quoteId: quote.quoteId,
    quoteVersion: SIMULATED_QUOTE_VERSION, quoteHash: simulatedQuoteHash(quote),
    seller: quote.seller, amountMinor: quote.totalMinor, currency: quote.currency,
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(issuedMs + SIMULATED_TOKEN_TTL_MS).toISOString(),
  };
}

export function authorizeSimulatedCheckout({ token, tokenState, request, quote, runId, now }) {
  // Check the wallet's stored scope, never a scope asserted by the agent.
  if (!token || request.tokenReference !== token.tokenReference) return { ok: false, reason: "TOKEN_MISMATCH" };
  if (tokenState === "revoked") return { ok: false, reason: "TOKEN_REVOKED" };
  if (tokenState !== "issued") return { ok: false, reason: "TOKEN_NOT_ISSUED" };
  if (token.maxUses !== 1) return { ok: false, reason: "TOKEN_MISMATCH" };
  if (!Number.isFinite(Date.parse(now)) || Date.parse(now) >= Date.parse(token.expiresAt)) {
    return { ok: false, reason: "TOKEN_EXPIRED" };
  }
  if (request.runId !== runId || token.runId !== runId) return { ok: false, reason: "WRONG_RUN" };
  if (request.seller !== quote.seller || token.seller !== quote.seller) return { ok: false, reason: "WRONG_SELLER" };
  if (request.currency !== quote.currency || token.currency !== quote.currency) return { ok: false, reason: "WRONG_CURRENCY" };
  if (token.quoteId !== quote.quoteId || token.quoteVersion !== SIMULATED_QUOTE_VERSION
    || token.quoteHash !== simulatedQuoteHash(quote)
    || request.quoteId !== token.quoteId || request.quoteVersion !== token.quoteVersion
    || request.quoteHash !== token.quoteHash) return { ok: false, reason: "QUOTE_CHANGED" };
  if (request.amountMinor !== quote.totalMinor || token.amountMinor !== quote.totalMinor) {
    return { ok: false, reason: "CHANGED_CART" };
  }
  return { ok: true, reason: null };
}
