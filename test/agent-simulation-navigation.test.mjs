import test from "node:test";
import assert from "node:assert/strict";
import { createAgentScenario } from "../lib/replay/agent-simulation-fixtures.mjs";
import { projectAgentScenario } from "../lib/replay/agent-simulation-reducer.mjs";
import { advanceScenarioCursor, nextScenarioAction } from "../lib/replay/agent-simulation-navigation.mjs";

test("M2 autoplay stops at every buyer action and only exact actions pass", () => {
  const scenario = createAgentScenario();
  for (const [cursor, action] of [[0, "buyer.session_opened"], [1, "buyer.mission_established"],
    [2, "buyer.wallet_connected"], [3, "buyer.browse_authorized"],
    [6, "buyer.product_selected"], [9, "buyer.purchase_approved"]]) {
    assert.equal(nextScenarioAction(scenario, cursor), action);
    assert.equal(advanceScenarioCursor(scenario, cursor), cursor);
    assert.equal(advanceScenarioCursor(scenario, cursor, "buyer.purchase_declined"), cursor);
    assert.equal(advanceScenarioCursor(scenario, cursor, action), cursor + 1);
  }
  assert.equal(nextScenarioAction(scenario, 4), null);
  assert.equal(advanceScenarioCursor(scenario, 4), 5);
  assert.equal(advanceScenarioCursor(scenario, 4, "buyer.purchase_approved"), 4);
  assert.equal(advanceScenarioCursor(scenario, scenario.events.length), scenario.events.length);
  assert.throws(() => nextScenarioAction(scenario, 19), RangeError);
});

test("M2 decline branch and seek remain projection-only with no future payment facts", () => {
  const declined = createAgentScenario({ fault: "buyer_decline" });
  assert.equal(advanceScenarioCursor(declined, 9, "buyer.purchase_declined"), 10);
  const end = projectAgentScenario(declined, 10);
  assert.equal(end.approval, "declined");
  assert.equal(end.token, "none");
  assert.equal(end.attempt, "none");
  assert.equal(end.order, "none");
  const before = projectAgentScenario(declined, 9);
  assert.equal(before.approval, "pending");
  assert.equal(before.visibleEvents.some(event => event.type === "buyer.purchase_declined"), false);
});
