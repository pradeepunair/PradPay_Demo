import test from "node:test";
import assert from "node:assert/strict";

import { calculateReferenceQuote } from "../lib/domain/money.mjs";
import { createAgentScenario, projectAgentScenario, validateScenario, simulationTime } from "../lib/replay/agent-simulation.mjs";

const copy = (value) => structuredClone(value);

test("M1 fixture is versioned, deterministic, ordered and request/response correlated", () => {
  const a = createAgentScenario();
  const b = createAgentScenario();
  assert.deepEqual(a, b);
  assert.equal(a.schemaVersion, "1.2.0");
  assert.equal(a.source, "local_simulation_fixture");
  assert.equal(a.events.length, 18);
  assert.equal(new Set(a.events.map((event) => event.eventId)).size, a.events.length);
  const requests = new Map();
  for (const [index, event] of a.events.entries()) {
    assert.equal(event.runId, a.runId);
    assert.equal(event.sequence, index + 1);
    assert.equal(event.occurredAt, simulationTime(index + 1));
    if (event.requestId) requests.set(event.requestId, event);
    if (event.responseTo) {
      const request = requests.get(event.responseTo);
      assert.ok(request, `Missing request for ${event.type}`);
      assert.equal(event.actor, request.recipient);
      assert.equal(event.recipient, request.actor);
    }
  }
  for (const request of requests.values()) {
    assert.ok(a.events.some((event) => event.responseTo === request.requestId),
      `Unanswered ${request.type}`);
  }
  assert.deepEqual(new Set(a.events.map((event) => event.eventClass)), new Set([
    "buyer_action", "agent_request", "seller_response", "wallet_response", "provider_request", "provider_evidence",
  ]));
  assert.equal(validateScenario(a), a);
  assert.equal(Object.isFrozen(a.events[0].safePayload), true);
});

test("M1 quote uses domain integer-money economics; no future authority leaks when seeking", () => {
  const scenario = createAgentScenario();
  const q = calculateReferenceQuote();
  const quote = scenario.events.find((event) => event.type === "seller.quote_returned").safePayload;
  assert.deepEqual([quote.productMinor, quote.discountMinor, quote.shippingMinor, quote.taxMinor, quote.totalMinor],
    [q.productMinor, q.discountMinor, q.shippingMinor, q.taxMinor, q.totalMinor]);
  assert.equal(quote.totalMinor, 30319);
  assert.equal(projectAgentScenario(scenario, 0).wallet, "disconnected");
  for (const cursor of [4, 9]) {
    const p = projectAgentScenario(scenario, cursor);
    assert.equal(p.approval, cursor === 9 ? "pending" : "not_requested");
    assert.equal(p.token, "none");
    assert.equal(p.order, "none");
    assert.equal(p.visibleEvents.some((event) => event.safePayload.tokenReference), false);
  }
  assert.equal(projectAgentScenario(scenario, 10).approval, "granted");
  assert.equal(projectAgentScenario(scenario, 12).token, "issued");
  assert.equal(projectAgentScenario(scenario, 14).order, "pending_payment");
  assert.equal(projectAgentScenario(scenario, 16).order, "pending_payment");
  assert.equal(projectAgentScenario(scenario, 17).order, "pending_payment");
  assert.equal(projectAgentScenario(scenario, 18).order, "confirmed");
  assert.equal(projectAgentScenario(scenario, 9).quote.totalMinor, 30319);
  assert.throws(() => projectAgentScenario(scenario, 19), RangeError);
});

test("M1 fault fixtures stop before authority or retain the original unknown attempt", () => {
  const refused = createAgentScenario({ fault: "merchant_refusal" });
  const blocked = projectAgentScenario(refused);
  assert.equal(blocked.checkout, "refused");
  assert.equal(blocked.approval, "not_requested");
  assert.equal(blocked.attempt, "none");
  assert.equal(blocked.order, "none");
  const declined = projectAgentScenario(createAgentScenario({ fault: "buyer_decline" }));
  assert.equal(declined.approval, "declined");
  assert.equal(declined.token, "none");
  assert.equal(declined.attempt, "none");
  const lost = createAgentScenario({ fault: "lost_response" });
  const unknown = projectAgentScenario(lost);
  assert.equal(unknown.attempt, "unknown");
  assert.equal(unknown.order, "pending_payment");
  assert.equal(unknown.evidence, "none");
  const recovered = createAgentScenario({ fault: "lost_response_recovered" });
  assert.equal(projectAgentScenario(recovered, lost.events.length).attempt, "unknown");
  assert.equal(projectAgentScenario(recovered).attemptId, unknown.attemptId);
  assert.equal(projectAgentScenario(recovered).order, "confirmed");
  assert.equal(recovered.events.filter((event) => event.type === "seller.payment_requested").length, 1);
});

test("M1 refuses broken correlation, order, time, and unsafe payloads", () => {
  const base = createAgentScenario();
  const mutate = (index, patch) => {
    const scenario = copy(base);
    Object.assign(scenario.events[index], patch);
    return scenario;
  };
  assert.throws(() => validateScenario(mutate(5, { responseTo: "sim_req_missing_01" })), /response correlation/);
  assert.throws(() => validateScenario({ ...copy(base), source: "stripe_verified" }), /header/);
  assert.throws(() => validateScenario(mutate(8, { responseTo: "sim_req_catalog_01" })), /response correlation/);
  assert.throws(() => validateScenario(mutate(5, { actor: "Atlas" })), /unsafe seller.catalog_returned/);
  assert.throws(() => validateScenario(mutate(5, { eventId: base.events[4].eventId })), /ordering or envelope/);
  assert.throws(() => validateScenario(mutate(5, { occurredAt: base.events[4].occurredAt })), /ordering or envelope/);
  assert.throws(() => validateScenario(mutate(9, { causeEventId: base.events[0].eventId })), /cause for buyer.purchase_approved/);
  assert.throws(() => validateScenario(mutate(11, { safePayload: {
    ...base.events[11].safePayload, cardNumber: "4242424242424242",
  } })), /unsafe wallet.token_issued/);
  assert.throws(() => projectAgentScenario(mutate(8, { safePayload: {
    ...base.events[8].safePayload, totalMinor: 30320,
  } })), /seller.quote_returned/);
  assert.throws(() => projectAgentScenario(mutate(9, { safePayload: {
    ...base.events[9].safePayload, amountMinor: 30318,
  } })), /buyer.purchase_approved/);
  assert.throws(() => projectAgentScenario(mutate(16, { safePayload: {
    ...base.events[16].safePayload, amountMinor: 30318,
  } })), /provider.callback_verified/);
});

test("unknown future event is display-only and cannot invent approval, token or order", () => {
  const scenario = copy(createAgentScenario({ fault: "merchant_refusal" }));
  const previous = scenario.events.at(-1);
  const future = { ...previous, eventId: "sim_evt_010", sequence: 10,
    occurredAt: simulationTime(10), type: "future.purchase_authorized", eventClass: "system",
    actor: "Simulation", recipient: "Atlas", causeEventId: previous.eventId,
    responseTo: null, requestId: null, safePayload: {}, evidenceRefs: [] };
  scenario.events.push(future);
  const projected = projectAgentScenario(scenario);
  assert.equal(projected.visibleEvents.length, 10);
  assert.equal(projected.approval, "not_requested");
  assert.equal(projected.token, "none");
  assert.equal(projected.order, "none");
  future.safePayload = { approvalId: "sim_forged_01" };
  assert.throws(() => validateScenario(scenario), /unsafe unknown event/);
});
