import test from "node:test";
import assert from "node:assert/strict";
import { createAgentScenario } from "../lib/replay/agent-simulation-fixtures.mjs";
import { projectAgentScenario } from "../lib/replay/agent-simulation-reducer.mjs";
import { advanceScenarioCursor, nextScenarioAction } from "../lib/replay/agent-simulation-navigation.mjs";
import { authorizeSimulatedCheckout, issueSimulatedToken, simulatedQuoteHash,
  SIMULATED_TOKEN_TTL_MS } from "../lib/replay/agent-simulation-authority.mjs";

const event = (scenario, type) => scenario.events.find(item => item.type === type);

test("W01 wallet connection and browsing budget never create payment authority", () => {
  const scenario = createAgentScenario();
  for (const cursor of [3, 4, 6, 9]) {
    const state = projectAgentScenario(scenario, cursor);
    assert.equal(state.token, "none");
    assert.equal(state.attempt, "none");
    assert.equal(state.order, "none");
  }
  assert.equal(projectAgentScenario(scenario, 9).approval, "pending");
  assert.equal(advanceScenarioCursor(scenario, 9), 9);
  assert.equal(advanceScenarioCursor(scenario, 9, "buyer.purchase_approved"), 10);
});

test("W03 token binds run, quote fingerprint/version, seller, amount, currency and expiry", () => {
  const scenario = createAgentScenario();
  const quote = event(scenario, "seller.quote_returned").safePayload;
  const issued = event(scenario, "wallet.token_issued");
  const token = issued.safePayload;
  const checkout = event(scenario, "agent.checkout_requested").safePayload;
  assert.match(token.tokenReference, /^sim_/);
  assert.equal(token.runId, scenario.runId);
  assert.equal(token.maxUses, 1);
  assert.equal(token.quoteId, quote.quoteId);
  assert.equal(token.quoteVersion, 1);
  assert.equal(token.quoteHash, simulatedQuoteHash(quote));
  assert.equal(token.seller, quote.seller);
  assert.equal(token.amountMinor, quote.totalMinor);
  assert.equal(token.currency, quote.currency);
  assert.equal(Date.parse(token.expiresAt) - Date.parse(token.issuedAt), SIMULATED_TOKEN_TTL_MS);
  assert.deepEqual(authorizeSimulatedCheckout({ token, tokenState: "issued", request: checkout,
    quote, runId: scenario.runId, now: issued.occurredAt }), { ok: true, reason: null });
  assert.equal(projectAgentScenario(scenario, 12).attempt, "none");
  assert.equal(projectAgentScenario(scenario, 13).token, "presented");
  assert.equal(projectAgentScenario(scenario).order, "confirmed");
});

test("W04 decline, revoke, expiry and changed cart stop before attempt reservation", () => {
  const expected = [
    ["buyer_decline", "declined", null],
    ["token_revoked", "granted", "TOKEN_REVOKED"],
    ["token_expired", "granted", "TOKEN_EXPIRED"],
    ["changed_cart", "granted", "CHANGED_CART"],
  ];
  for (const [fault, approval, reason] of expected) {
    const scenario = createAgentScenario({ fault });
    const state = projectAgentScenario(scenario);
    assert.equal(state.approval, approval, fault);
    assert.equal(state.checkoutDeniedReason, reason, fault);
    assert.equal(state.attempt, "none", fault);
    assert.equal(state.order, "none", fault);
    assert.equal(scenario.events.some(item => item.type === "seller.payment_requested"), false, fault);
    assert.equal(scenario.events.some(item => item.type === "seller.attempt_reserved"), false, fault);
    if (reason) assert.equal(event(scenario, "seller.checkout_denied").safePayload.reason, reason);
  }
  assert.equal(projectAgentScenario(createAgentScenario({ fault: "token_revoked" })).token, "revoked");
  assert.equal(projectAgentScenario(createAgentScenario({ fault: "token_expired" })).token, "issued");
  const revocation = createAgentScenario({ fault: "token_revoked" });
  assert.equal(nextScenarioAction(revocation, 12), "buyer.token_revoked");
  assert.equal(advanceScenarioCursor(revocation, 12), 12);
  assert.equal(advanceScenarioCursor(revocation, 12, "buyer.token_revoked"), 13);
});

test("W05 wrong run, seller, currency, amount, quote and time fail closed", () => {
  const scenario = createAgentScenario();
  const quote = event(scenario, "seller.quote_returned").safePayload;
  const token = event(scenario, "wallet.token_issued").safePayload;
  const request = event(scenario, "agent.checkout_requested").safePayload;
  const base = { token, tokenState: "issued", request, quote, runId: scenario.runId,
    now: event(scenario, "agent.checkout_requested").occurredAt };
  for (const [patch, reason] of [
    [{ request: { ...request, runId: "sim_other_run" } }, "WRONG_RUN"],
    [{ request: { ...request, seller: "Other seller" } }, "WRONG_SELLER"],
    [{ request: { ...request, currency: "EUR" } }, "WRONG_CURRENCY"],
    [{ request: { ...request, amountMinor: request.amountMinor + 1 } }, "CHANGED_CART"],
    [{ request: { ...request, quoteHash: "sim_hash_changed" } }, "QUOTE_CHANGED"],
    [{ now: token.expiresAt }, "TOKEN_EXPIRED"],
    [{ tokenState: "revoked" }, "TOKEN_REVOKED"],
  ]) {
    assert.deepEqual(authorizeSimulatedCheckout({ ...base, ...patch }), { ok: false, reason });
  }
  const changedQuote = { ...quote, taxMinor: quote.taxMinor + 1 };
  assert.equal(authorizeSimulatedCheckout({ ...base, quote: changedQuote }).reason, "QUOTE_CHANGED");
  const forged = structuredClone(scenario);
  event(forged, "agent.checkout_requested").safePayload.amountMinor += 1;
  const before = projectAgentScenario(forged, 13);
  assert.equal(before.checkout, "blocked");
  assert.equal(before.attempt, "none");
  assert.throws(() => projectAgentScenario(forged), /seller.attempt_reserved/);
  const wrongToken = issueSimulatedToken({ runId: "sim_other_run", approvalId: token.approvalId,
    quote, issuedAt: token.issuedAt });
  assert.equal(authorizeSimulatedCheckout({ ...base, token: wrongToken }).reason, "WRONG_RUN");
  const forgedIssue = structuredClone(scenario);
  event(forgedIssue, "wallet.token_issued").safePayload.expiresAt =
    new Date(Date.parse(token.expiresAt) + 60_000).toISOString();
  assert.throws(() => projectAgentScenario(forgedIssue, 12), /wallet.token_issued/);
});
