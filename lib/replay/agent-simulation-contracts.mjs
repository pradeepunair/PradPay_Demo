// Agent Studio v1 is a local teaching contract, separate from Stripe, ACP and
// the classic replay format. Only allowlisted, non-secret facts are recorded.
import { STUDIO_CATALOG } from "./agent-simulation-commerce.mjs";
export const SCENARIO_VERSION = "1.2.0";
export const REFERENCE_TIME = "2026-09-30T12:00:00.000Z";
export const STEP_MS = 1_000;
export const FAULTS = Object.freeze(["none", "merchant_refusal", "buyer_decline", "token_revoked", "token_expired", "changed_cart", "lost_response", "lost_response_recovered"]);

const text = (v) => typeof v === "string" && v.length > 0 && v.length <= 160;
const id = (v) => typeof v === "string" && /^sim_[a-z0-9_]{3,80}$/.test(v);
const minor = (v) => Number.isSafeInteger(v) && v >= 0;
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const time = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const oneOf = (...values) => (v) => values.includes(v);
const fields = (payload, schema) => payload && typeof payload === "object" && !Array.isArray(payload)
  && Object.keys(payload).sort().join(",") === Object.keys(schema).sort().join(",")
  && Object.entries(schema).every(([key, check]) => check(payload[key]));

// Each known type fixes its route, class and exact safe-payload shape. Unknown
// future types can be displayed with an empty payload but have no authority.
export const EVENT_DEFINITIONS = Object.freeze({
  "buyer.session_opened": { eventClass: "buyer_action", actor: "Buyer", recipient: "Atlas", payload: { sessionId: id } },
  "buyer.mission_established": { eventClass: "buyer_action", actor: "Buyer", recipient: "Atlas", payload: {
    missionId: id, category: oneOf("wireless_headphones"), quantity: oneOf(1), batteryHoursMin: positive,
    deliveryDaysMax: positive, maxTotalMinor: minor, currency: oneOf("USD"),
  } },
  "buyer.wallet_connected": { eventClass: "buyer_action", actor: "Buyer", recipient: "Wallet", payload: { walletReference: id } },
  "buyer.browse_authorized": { eventClass: "buyer_action", actor: "Buyer", recipient: "Atlas", payload: { missionId: id } },
  "agent.catalog_requested": { eventClass: "agent_request", actor: "Atlas", recipient: "Seller agent", payload: { missionId: id } },
  "seller.catalog_returned": { eventClass: "seller_response", actor: "Seller agent", recipient: "Atlas", payload: { catalogVersion: oneOf(1), productCount: oneOf(6) } },
  "buyer.product_selected": { eventClass: "buyer_action", actor: "Buyer", recipient: "Atlas", payload: { productId: oneOf(...STUDIO_CATALOG.map(item => item.id)) } },
  "agent.quote_requested": { eventClass: "agent_request", actor: "Atlas", recipient: "Seller agent", payload: { productId: oneOf(...STUDIO_CATALOG.map(item => item.id)), quantity: oneOf(1) } },
  "seller.quote_returned": { eventClass: "seller_response", actor: "Seller agent", recipient: "Atlas", payload: {
    quoteId: id, productId: oneOf(...STUDIO_CATALOG.map(item => item.id)), seller: oneOf("Northstar Audio"),
    productMinor: minor, discountMinor: minor, shippingMinor: minor, taxMinor: minor,
    totalMinor: minor, currency: oneOf("USD"), reservationReference: id, reservationStatus: oneOf("simulated"),
  } },
  "seller.quote_refused": { eventClass: "seller_response", actor: "Seller agent", recipient: "Atlas", payload: {
    reason: oneOf("OUT_OF_STOCK", "BATTERY_BELOW_MINIMUM", "DELIVERY_TOO_SLOW", "OVER_BUDGET", "MERCHANT_DECLINED"),
  } },
  "buyer.purchase_approved": { eventClass: "buyer_action", actor: "Buyer", recipient: "Wallet", payload: {
    approvalId: id, quoteId: id, seller: oneOf("Northstar Audio"), amountMinor: minor, currency: oneOf("USD"),
  } },
  "buyer.purchase_declined": { eventClass: "buyer_action", actor: "Buyer", recipient: "Wallet", payload: {
    quoteId: id, decision: oneOf("declined"),
  } },
  "agent.token_requested": { eventClass: "agent_request", actor: "Atlas", recipient: "Wallet", payload: { approvalId: id } },
  "wallet.token_issued": { eventClass: "wallet_response", actor: "Wallet", recipient: "Atlas", payload: {
    tokenReference: id, runId: id, approvalId: id, maxUses: oneOf(1), quoteId: id, quoteVersion: oneOf(1), quoteHash: id,
    seller: oneOf("Northstar Audio"), amountMinor: minor, currency: oneOf("USD"), issuedAt: time, expiresAt: time,
  } },
  "buyer.token_revoked": { eventClass: "buyer_action", actor: "Buyer", recipient: "Wallet", payload: { tokenReference: id } },
  "simulation.clock_advanced": { eventClass: "system", actor: "Simulation", recipient: "Atlas", payload: { effectiveAt: time } },
  "agent.checkout_requested": { eventClass: "agent_request", actor: "Atlas", recipient: "Seller backend", payload: {
    runId: id, quoteId: id, quoteVersion: oneOf(1), quoteHash: id, seller: oneOf("Northstar Audio"),
    amountMinor: minor, currency: oneOf("USD"), tokenReference: id,
  } },
  "seller.checkout_denied": { eventClass: "seller_response", actor: "Seller backend", recipient: "Atlas", payload: {
    reason: oneOf("TOKEN_MISMATCH", "TOKEN_REVOKED", "TOKEN_NOT_ISSUED", "TOKEN_EXPIRED",
      "WRONG_RUN", "WRONG_SELLER", "WRONG_CURRENCY", "QUOTE_CHANGED", "CHANGED_CART"),
  } },
  "seller.attempt_reserved": { eventClass: "seller_response", actor: "Seller backend", recipient: "Atlas", payload: { attemptId: id, orderId: id } },
  "seller.payment_requested": { eventClass: "provider_request", actor: "Seller backend", recipient: "Payment simulator", payload: { attemptId: id, amountMinor: minor, currency: oneOf("USD") } },
  "provider.response_received": { eventClass: "provider_evidence", actor: "Payment simulator", recipient: "Seller backend", payload: {
    attemptId: id, paymentReference: id, status: oneOf("succeeded", "failed"), amountMinor: minor, currency: oneOf("USD"),
  } },
  "provider.response_lost": { eventClass: "system", actor: "Simulation", recipient: "Seller backend", payload: { attemptId: id } },
  "provider.callback_verified": { eventClass: "provider_evidence", actor: "Payment simulator", recipient: "Seller backend", payload: {
    attemptId: id, paymentReference: id, evidenceReference: id, status: oneOf("succeeded"), amountMinor: minor, currency: oneOf("USD"),
  } },
  "seller.order_confirmed": { eventClass: "seller_response", actor: "Seller backend", recipient: "Atlas", payload: { orderId: id, evidenceReference: id } },
});

const requestTypes = new Set(Object.keys(EVENT_DEFINITIONS).filter((type) => EVENT_DEFINITIONS[type].eventClass.endsWith("request")));
const responseTypes = new Set(Object.keys(EVENT_DEFINITIONS).filter((type) => ["seller_response", "wallet_response"].includes(EVENT_DEFINITIONS[type].eventClass)));
responseTypes.add("provider.response_received");
const RESPONSE_REQUEST_TYPE = Object.freeze({
  "seller.catalog_returned": "agent.catalog_requested",
  "seller.quote_returned": "agent.quote_requested",
  "seller.quote_refused": "agent.quote_requested",
  "wallet.token_issued": "agent.token_requested",
  "seller.attempt_reserved": "agent.checkout_requested",
  "seller.checkout_denied": "agent.checkout_requested",
  "provider.response_received": "seller.payment_requested",
  "seller.order_confirmed": "agent.checkout_requested",
});
const REQUIRED_CAUSE_TYPE = Object.freeze({
  "buyer.purchase_approved": ["seller.quote_returned"],
  "buyer.purchase_declined": ["seller.quote_returned"],
  "wallet.token_issued": ["agent.token_requested"],
  "provider.callback_verified": ["provider.response_received", "provider.response_lost"],
  "seller.order_confirmed": ["provider.callback_verified"],
});
const eventKeys = ["schemaVersion", "runId", "eventId", "sequence", "occurredAt", "eventClass", "type", "actor", "recipient",
  "requestId", "responseTo", "causeEventId", "safePayload", "evidenceRefs"];
const fail = (reason) => { throw new Error(`Invalid agent scenario: ${reason}`); };

export function simulationTime(sequence, referenceTime = REFERENCE_TIME, stepMs = STEP_MS) {
  if (!positive(sequence) || !positive(stepMs) || !Number.isFinite(Date.parse(referenceTime))
    || new Date(referenceTime).toISOString() !== referenceTime) fail("invalid simulation clock");
  return new Date(Date.parse(referenceTime) + (sequence - 1) * stepMs).toISOString();
}

export function validateScenario(scenario) {
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)
    || Object.keys(scenario).sort().join(",") !== "events,fault,referenceTime,runId,schemaVersion,source,stepMs"
    || scenario.schemaVersion !== SCENARIO_VERSION || scenario.source !== "local_simulation_fixture" || !id(scenario.runId)
    || !FAULTS.includes(scenario.fault) || !Array.isArray(scenario.events)
    || !Number.isFinite(Date.parse(scenario.referenceTime))
    || !positive(scenario.stepMs)) fail("header");
  const eventIds = new Set();
  const eventsById = new Map();
  const requests = new Map();
  for (const [index, event] of scenario.events.entries()) {
    if (!event || Object.keys(event).sort().join(",") !== [...eventKeys].sort().join(",")
      || event.schemaVersion !== SCENARIO_VERSION || event.runId !== scenario.runId
      || event.sequence !== index + 1 || !id(event.eventId) || eventIds.has(event.eventId)
      || event.occurredAt !== simulationTime(event.sequence, scenario.referenceTime, scenario.stepMs)
      || !text(event.type) || !text(event.actor) || !text(event.recipient)
      || !Array.isArray(event.evidenceRefs) || !event.evidenceRefs.every(id)
      || (index === 0 ? event.causeEventId !== null : !eventIds.has(event.causeEventId))) fail("ordering or envelope");
    const definition = EVENT_DEFINITIONS[event.type];
    if (REQUIRED_CAUSE_TYPE[event.type]
      && !REQUIRED_CAUSE_TYPE[event.type].includes(eventsById.get(event.causeEventId)?.type)) {
      fail(`cause for ${event.type}`);
    }
    if (definition) {
      if (event.eventClass !== definition.eventClass || event.actor !== definition.actor
        || event.recipient !== definition.recipient || !fields(event.safePayload, definition.payload)) fail(`unsafe ${event.type}`);
    } else if (event.eventClass !== "system" || !fields(event.safePayload, {})) fail("unsafe unknown event");
    if (requestTypes.has(event.type)) {
      if (!id(event.requestId) || requests.has(event.requestId) || event.responseTo !== null) fail("request correlation");
      requests.set(event.requestId, event);
    } else if (responseTypes.has(event.type)) {
      const request = requests.get(event.responseTo);
      if (event.requestId !== null || !request || event.actor !== request.recipient
        || event.recipient !== request.actor || request.type !== RESPONSE_REQUEST_TYPE[event.type]) fail("response correlation");
    } else if (event.requestId !== null || event.responseTo !== null) fail("unexpected correlation");
    eventIds.add(event.eventId);
    eventsById.set(event.eventId, event);
  }
  return scenario;
}
