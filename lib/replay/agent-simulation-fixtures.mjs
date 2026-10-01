import { compareStudioCatalog, DEFAULT_STUDIO_MISSION, requestStudioQuote,
  STUDIO_CATALOG, validateStudioMission } from "./agent-simulation-commerce.mjs";
import { FAULTS, REFERENCE_TIME, SCENARIO_VERSION, STEP_MS,
  EVENT_DEFINITIONS, simulationTime, validateScenario } from "./agent-simulation-contracts.mjs";
import { projectAgentScenario } from "./agent-simulation-reducer.mjs";
import { issueSimulatedToken } from "./agent-simulation-authority.mjs";

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Build a deterministic, credential-free scenario; fault is the only branch. */
export function createAgentScenario({ runId = "sim_run_atlas_northstar_v1", fault = "none",
  referenceTime = REFERENCE_TIME, stepMs = STEP_MS,
  mission = DEFAULT_STUDIO_MISSION, selectedProductId } = {}) {
  if (!FAULTS.includes(fault)) throw new Error("Unsupported simulation fault");
  const terms = validateStudioMission(mission);
  const productId = selectedProductId ?? compareStudioCatalog(terms).recommendedProductId ?? "aurora-pro";
  if (!STUDIO_CATALOG.some(item => item.id === productId)) throw new Error("UNKNOWN_STUDIO_PRODUCT");
  const events = [];
  const scenario = { schemaVersion: SCENARIO_VERSION, source: "local_simulation_fixture",
    runId, referenceTime, stepMs, fault, events };
  function add(type, safePayload, { requestId = null, responseTo = null, evidenceRefs = [] } = {}) {
    const sequence = events.length + 1;
    const definition = EVENT_DEFINITIONS[type];
    events.push({ schemaVersion: SCENARIO_VERSION, runId, eventId: `sim_evt_${String(sequence).padStart(3, "0")}`,
      sequence, occurredAt: simulationTime(sequence, referenceTime, stepMs),
      eventClass: definition.eventClass, type, actor: definition.actor, recipient: definition.recipient,
      requestId, responseTo, causeEventId: events.at(-1)?.eventId ?? null,
      safePayload, evidenceRefs });
  }
  const quoteResult = requestStudioQuote({ productId, quantity: 1 }, terms);
  const missionId = "sim_mission_01", approvalId = "sim_approval_01";
  const attemptId = "sim_attempt_01", orderId = "sim_order_01", evidenceReference = "sim_evidence_01";
  add("buyer.session_opened", { sessionId: "sim_session_01" });
  add("buyer.mission_established", { missionId, ...terms });
  add("buyer.wallet_connected", { walletReference: "sim_wallet_01" });
  add("buyer.browse_authorized", { missionId });
  add("agent.catalog_requested", { missionId }, { requestId: "sim_req_catalog_01" });
  add("seller.catalog_returned", { catalogVersion: 1, productCount: 6 }, { responseTo: "sim_req_catalog_01" });
  add("buyer.product_selected", { productId });
  add("agent.quote_requested", { productId, quantity: 1 }, { requestId: "sim_req_quote_01" });
  if (fault === "merchant_refusal" || quoteResult.outcome === "refused") {
    add("seller.quote_refused", { reason: fault === "merchant_refusal" ? "MERCHANT_DECLINED" : quoteResult.reason },
      { responseTo: "sim_req_quote_01" });
  } else {
    const quote = quoteResult.quote;
    const { quoteId } = quote;
    add("seller.quote_returned", quote, { responseTo: "sim_req_quote_01" });
    if (fault === "buyer_decline") {
      add("buyer.purchase_declined", { quoteId, decision: "declined" });
    } else {
      add("buyer.purchase_approved", { approvalId, quoteId, seller: "Northstar Audio",
        amountMinor: quote.totalMinor, currency: "USD" });
      add("agent.token_requested", { approvalId }, { requestId: "sim_req_token_01" });
      const token = issueSimulatedToken({ runId, approvalId, quote,
        issuedAt: simulationTime(events.length + 1, referenceTime, stepMs) });
      add("wallet.token_issued", token, { responseTo: "sim_req_token_01" });
      if (fault === "token_revoked") add("buyer.token_revoked", { tokenReference: token.tokenReference });
      if (fault === "token_expired") add("simulation.clock_advanced", {
        effectiveAt: new Date(Date.parse(token.expiresAt) + 1).toISOString(),
      });
      const checkoutRequest = { runId, quoteId, quoteVersion: token.quoteVersion,
        quoteHash: token.quoteHash, seller: token.seller,
        amountMinor: quote.totalMinor + (fault === "changed_cart" ? 100 : 0),
        currency: token.currency, tokenReference: token.tokenReference };
      add("agent.checkout_requested", checkoutRequest, { requestId: "sim_req_checkout_01" });
      if (["token_revoked", "token_expired", "changed_cart"].includes(fault)) {
        add("seller.checkout_denied", { reason: fault === "token_revoked" ? "TOKEN_REVOKED"
          : fault === "token_expired" ? "TOKEN_EXPIRED" : "CHANGED_CART" },
        { responseTo: "sim_req_checkout_01" });
      } else {
        add("seller.attempt_reserved", { attemptId, orderId }, { responseTo: "sim_req_checkout_01" });
        add("seller.payment_requested", { attemptId, amountMinor: quote.totalMinor, currency: "USD" },
          { requestId: "sim_req_provider_01" });
        if (fault === "lost_response" || fault === "lost_response_recovered") {
          add("provider.response_lost", { attemptId });
        } else {
          add("provider.response_received", { attemptId, paymentReference: "sim_payment_01",
            status: "succeeded", amountMinor: quote.totalMinor, currency: "USD" },
          { responseTo: "sim_req_provider_01" });
        }
        if (fault !== "lost_response") {
          add("provider.callback_verified", { attemptId, paymentReference: "sim_payment_01",
            evidenceReference, status: "succeeded", amountMinor: quote.totalMinor, currency: "USD" },
          { evidenceRefs: [evidenceReference] });
          add("seller.order_confirmed", { orderId, evidenceReference },
            { responseTo: "sim_req_checkout_01", evidenceRefs: [evidenceReference] });
        }
      }
    }
  }
  validateScenario(scenario);
  projectAgentScenario(scenario); // Fixture must satisfy every state transition.
  return freeze(scenario);
}
