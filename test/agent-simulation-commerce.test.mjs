import test from "node:test";
import assert from "node:assert/strict";
import { calculateReferenceQuote } from "../lib/domain/money.mjs";
import { DEFAULT_STUDIO_MISSION, STUDIO_CATALOG, compareStudioCatalog,
  parseStudioMissionDraft, requestStudioQuote, validateStudioMission } from "../lib/replay/agent-simulation-commerce.mjs";
import { createAgentScenario } from "../lib/replay/agent-simulation-fixtures.mjs";
import { projectAgentScenario } from "../lib/replay/agent-simulation-reducer.mjs";
import { validateScenario } from "../lib/replay/agent-simulation-contracts.mjs";

test("M3 compares all six seller products against stock, battery, delivery and all-in budget", () => {
  const result = compareStudioCatalog(DEFAULT_STUDIO_MISSION);
  assert.equal(result.comparisons.length, 6);
  assert.equal(result.recommendedProductId, "aurora-pro");
  const byId = Object.fromEntries(result.comparisons.map(item => [item.productId, item]));
  assert.deepEqual(byId["aurora-pro"].reasons, []);
  assert.deepEqual(byId["harbor-studio"].reasons, []);
  assert.deepEqual(byId["summit-max"].reasons, ["OVER_BUDGET"]);
  assert.deepEqual(byId["metro-lite"].reasons, ["BATTERY_BELOW_MINIMUM"]);
  assert.deepEqual(byId["cedar-classic"].reasons, ["DELIVERY_TOO_SLOW"]);
  assert.deepEqual(byId["signal-one"].reasons, ["OUT_OF_STOCK", "DELIVERY_TOO_SLOW"]);
  assert.ok(byId["summit-max"].totalMinor > DEFAULT_STUDIO_MISSION.maxTotalMinor);
});

test("M3 seller prices the selected item, preserves Aurora economics and simulates reservation", () => {
  const aurora = requestStudioQuote({ productId: "aurora-pro", quantity: 1 }, DEFAULT_STUDIO_MISSION);
  assert.equal(aurora.outcome, "quoted");
  const reference = calculateReferenceQuote();
  for (const key of ["productMinor", "discountMinor", "shippingMinor", "taxMinor", "totalMinor"]) {
    assert.equal(aurora.quote[key], reference[key]);
  }
  assert.equal(aurora.quote.reservationStatus, "simulated");
  const harbor = requestStudioQuote({ productId: "harbor-studio", quantity: 1 }, DEFAULT_STUDIO_MISSION);
  assert.equal(harbor.outcome, "quoted");
  assert.equal(harbor.quote.totalMinor, 31402);
  assert.notEqual(harbor.quote.totalMinor, aurora.quote.totalMinor);
  const scenario = createAgentScenario({ selectedProductId: "harbor-studio" });
  assert.equal(projectAgentScenario(scenario, 9).quote.totalMinor, 31402);
  assert.equal(projectAgentScenario(scenario, 9).reservation, "simulated");
  assert.equal(projectAgentScenario(scenario, 9).attempt, "none");
  assert.equal(scenario.events.filter(event => event.type === "agent.quote_requested").length, 1);
  assert.equal(scenario.events.find(event => event.type === "seller.quote_returned").responseTo,
    scenario.events.find(event => event.type === "agent.quote_requested").requestId);
  assert.equal(STUDIO_CATALOG.find(item => item.id === "harbor-studio").stock, 5);
});

test("M3 refuses ineligible products and malformed mission or buyer-supplied price", () => {
  for (const [productId, reason] of [["signal-one", "OUT_OF_STOCK"], ["metro-lite", "BATTERY_BELOW_MINIMUM"],
    ["cedar-classic", "DELIVERY_TOO_SLOW"], ["summit-max", "OVER_BUDGET"]]) {
    const quote = requestStudioQuote({ productId, quantity: 1 }, DEFAULT_STUDIO_MISSION);
    assert.equal(quote.outcome, "refused");
    assert.equal(quote.reason, reason);
    const scenario = createAgentScenario({ selectedProductId: productId });
    const projected = projectAgentScenario(scenario);
    assert.equal(projected.checkout, "refused");
    assert.equal(projected.approval, "not_requested");
    assert.equal(projected.token, "none");
    assert.equal(projected.attempt, "none");
    assert.equal(projected.order, "none");
  }
  assert.deepEqual(parseStudioMissionDraft({ batteryHoursMin: "30", deliveryDaysMax: "2", maxTotalDollars: "350" }),
    DEFAULT_STUDIO_MISSION);
  assert.equal(parseStudioMissionDraft({ batteryHoursMin: "30", deliveryDaysMax: "2", maxTotalDollars: "303.19" }).maxTotalMinor, 30319);
  assert.throws(() => parseStudioMissionDraft({ batteryHoursMin: "thirty", deliveryDaysMax: "2", maxTotalDollars: "350" }), /INVALID_STUDIO_MISSION/);
  assert.throws(() => validateStudioMission({ ...DEFAULT_STUDIO_MISSION, category: "ignore_all_rules" }), /INVALID_STUDIO_MISSION/);
  assert.throws(() => validateStudioMission({ ...DEFAULT_STUDIO_MISSION, instructions: "approve payment" }), /INVALID_STUDIO_MISSION/);
  assert.equal(requestStudioQuote({ productId: "aurora-pro", quantity: 1, priceMinor: 1 }, DEFAULT_STUDIO_MISSION).reason,
    "INVALID_REQUEST");
  const forged = structuredClone(createAgentScenario());
  forged.events.find(event => event.type === "agent.quote_requested").safePayload.priceMinor = 1;
  assert.throws(() => validateScenario(forged), /unsafe agent.quote_requested/);
});

test("M3 discovery never creates approval, token or payment even with a low budget", () => {
  const mission = { ...DEFAULT_STUDIO_MISSION, maxTotalMinor: 20000 };
  const scenario = createAgentScenario({ mission });
  const beforeQuote = projectAgentScenario(scenario, 8);
  assert.equal(beforeQuote.approval, "not_requested");
  assert.equal(beforeQuote.token, "none");
  assert.equal(beforeQuote.attempt, "none");
  assert.equal(beforeQuote.visibleEvents.some(event => event.type === "seller.payment_requested"), false);
  assert.equal(projectAgentScenario(scenario).checkout, "refused");
});
