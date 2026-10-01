import { requestStudioQuote, validateStudioMission } from "./agent-simulation-commerce.mjs";
import { authorizeSimulatedCheckout, issueSimulatedToken } from "./agent-simulation-authority.mjs";
import { EVENT_DEFINITIONS, validateScenario } from "./agent-simulation-contracts.mjs";

export const initialScenarioState = Object.freeze({
  session: "closed", wallet: "disconnected", mission: "absent", browsing: "not_authorized",
  discovery: "not_requested", checkout: "none", approval: "not_requested", token: "none",
  attempt: "none", order: "none", evidence: "none", missionTerms: null, quote: null,
  approvalId: null, tokenReference: null, attemptId: null, orderId: null, evidenceReference: null,
  selectedProductId: null, reservationReference: null, reservation: "none",
  tokenScope: null, clockAt: null, checkoutDeniedReason: null,
});

const requireState = (condition, event) => {
  if (!condition) throw new Error(`Invalid agent scenario transition: ${event.type}`);
};
const missionFromState = (state) => {
  const { category, quantity, batteryHoursMin, deliveryDaysMax, maxTotalMinor, currency } = state.missionTerms;
  return { category, quantity, batteryHoursMin, deliveryDaysMax, maxTotalMinor, currency };
};

function reduceScenarioEvent(previous, event) {
  // Never apply an unfamiliar type, even if it advertises a familiar class.
  if (!Object.hasOwn(EVENT_DEFINITIONS, event.type)) return previous;
  const state = structuredClone(previous);
  const p = event.safePayload;
  switch (event.type) {
    case "buyer.session_opened":
      requireState(state.session === "closed", event); state.session = "open"; break;
    case "buyer.mission_established":
      requireState(state.session === "open" && state.mission === "absent", event);
      validateStudioMission({ category: p.category, quantity: p.quantity, batteryHoursMin: p.batteryHoursMin,
        deliveryDaysMax: p.deliveryDaysMax, maxTotalMinor: p.maxTotalMinor, currency: p.currency });
      state.mission = "established"; state.missionTerms = structuredClone(p); break;
    case "buyer.wallet_connected":
      requireState(state.session === "open" && state.wallet === "disconnected", event);
      state.wallet = "connected"; break;
    case "buyer.browse_authorized":
      requireState(state.wallet === "connected" && state.mission === "established"
        && p.missionId === state.missionTerms.missionId, event);
      state.browsing = "authorized"; break;
    case "agent.catalog_requested":
      requireState(state.browsing === "authorized" && p.missionId === state.missionTerms.missionId, event);
      state.discovery = "requested"; break;
    case "seller.catalog_returned":
      requireState(state.discovery === "requested", event); state.discovery = "returned"; break;
    case "buyer.product_selected":
      requireState(state.discovery === "returned" && state.checkout === "none", event);
      state.selectedProductId = p.productId; break;
    case "agent.quote_requested":
      requireState(state.discovery === "returned" && state.selectedProductId === p.productId
        && state.checkout === "none", event);
      state.checkout = "quote_requested"; break;
    case "seller.quote_refused": {
      const expected = requestStudioQuote({ productId: state.selectedProductId, quantity: 1 }, missionFromState(state));
      requireState(state.checkout === "quote_requested" && (p.reason === "MERCHANT_DECLINED"
        || (expected.outcome === "refused" && p.reason === expected.reason)), event);
      state.checkout = "refused"; break;
    }
    case "seller.quote_returned": {
      const expected = requestStudioQuote({ productId: state.selectedProductId, quantity: 1 }, missionFromState(state));
      requireState(state.checkout === "quote_requested" && expected.outcome === "quoted"
        && Object.entries(expected.quote).every(([key, value]) => p[key] === value), event);
      state.checkout = "quoted"; state.approval = "pending"; state.quote = structuredClone(p);
      state.reservation = "simulated"; state.reservationReference = p.reservationReference; break;
    }
    case "buyer.purchase_approved":
      requireState(state.checkout === "quoted" && state.approval === "pending"
        && p.quoteId === state.quote.quoteId && p.seller === state.quote.seller
        && p.amountMinor === state.quote.totalMinor && p.currency === state.quote.currency, event);
      state.approval = "granted"; state.approvalId = p.approvalId; break;
    case "buyer.purchase_declined":
      requireState(state.checkout === "quoted" && state.approval === "pending"
        && p.quoteId === state.quote.quoteId, event);
      state.approval = "declined"; break;
    case "agent.token_requested":
      requireState(state.approval === "granted" && state.token === "none" && p.approvalId === state.approvalId, event);
      state.token = "requested"; break;
    case "wallet.token_issued":
      const expectedToken = issueSimulatedToken({ runId: event.runId,
        approvalId: state.approvalId, quote: state.quote, issuedAt: event.occurredAt });
      requireState(state.token === "requested" && p.approvalId === state.approvalId
        && p.quoteId === state.quote.quoteId && p.seller === state.quote.seller
        && p.amountMinor === state.quote.totalMinor && p.currency === state.quote.currency
        && Object.entries(expectedToken).every(([key, value]) => p[key] === value), event);
      state.token = "issued"; state.tokenReference = p.tokenReference;
      state.tokenScope = structuredClone(p); break;
    case "buyer.token_revoked":
      requireState(state.token === "issued" && state.checkout === "quoted"
        && p.tokenReference === state.tokenReference, event);
      state.token = "revoked"; break;
    case "simulation.clock_advanced":
      requireState(state.token === "issued" && state.checkout === "quoted"
        && Date.parse(p.effectiveAt) >= Date.parse(state.clockAt), event);
      state.clockAt = p.effectiveAt; break;
    case "agent.checkout_requested":
      requireState(state.approval === "granted" && state.checkout === "quoted", event);
      const authorization = authorizeSimulatedCheckout({ token: state.tokenScope,
        tokenState: state.token, request: p, quote: state.quote,
        runId: event.runId, now: state.clockAt });
      state.checkout = authorization.ok ? "completing" : "blocked";
      if (authorization.ok) state.token = "presented";
      state.checkoutDeniedReason = authorization.reason; break;
    case "seller.checkout_denied":
      requireState(state.checkout === "blocked" && p.reason === state.checkoutDeniedReason
        && state.attempt === "none", event); break;
    case "seller.attempt_reserved":
      requireState(state.checkout === "completing" && state.attempt === "none", event);
      state.attempt = "reserved"; state.order = "pending_payment";
      state.attemptId = p.attemptId; state.orderId = p.orderId; break;
    case "seller.payment_requested":
      requireState(state.attempt === "reserved" && p.attemptId === state.attemptId
        && p.amountMinor === state.quote.totalMinor && p.currency === state.quote.currency, event);
      state.attempt = "submitted"; break;
    case "provider.response_received":
      requireState(state.attempt === "submitted" && p.attemptId === state.attemptId
        && p.amountMinor === state.quote.totalMinor && p.currency === state.quote.currency, event);
      state.attempt = p.status; if (p.status === "failed") state.order = "payment_failed"; break;
    case "provider.response_lost":
      requireState(state.attempt === "submitted" && p.attemptId === state.attemptId, event);
      state.attempt = "unknown"; break;
    case "provider.callback_verified":
      requireState(["unknown", "succeeded"].includes(state.attempt) && state.order === "pending_payment"
        && p.attemptId === state.attemptId && p.amountMinor === state.quote.totalMinor
        && p.currency === state.quote.currency, event);
      state.attempt = "succeeded"; state.evidence = "verified";
      state.evidenceReference = p.evidenceReference; break;
    case "seller.order_confirmed":
      requireState(state.evidence === "verified" && state.order === "pending_payment"
        && p.orderId === state.orderId && p.evidenceReference === state.evidenceReference, event);
      state.order = "confirmed"; state.checkout = "completed"; break;
  }
  return state;
}

export function projectAgentScenario(scenario, cursor = scenario.events.length) {
  validateScenario(scenario);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > scenario.events.length) {
    throw new RangeError("Invalid agent scenario cursor");
  }
  let state = initialScenarioState;
  for (const event of scenario.events.slice(0, cursor)) {
    const clockAt = !state.clockAt || Date.parse(event.occurredAt) > Date.parse(state.clockAt)
      ? event.occurredAt : state.clockAt;
    state = reduceScenarioEvent({ ...state, clockAt }, event);
  }
  return { ...structuredClone(state), cursor, visibleEvents: structuredClone(scenario.events.slice(0, cursor)) };
}
