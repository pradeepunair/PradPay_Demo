import { projectAgentScenario } from "./agent-simulation-reducer.mjs";

// Navigation changes only a replay cursor. It never creates an event or calls
// a provider. Buyer actions must be dispatched by their exact event type.
export function nextScenarioAction(scenario, cursor) {
  projectAgentScenario(scenario, cursor);
  const next = scenario.events[cursor];
  return next?.eventClass === "buyer_action" ? next.type : null;
}

export function advanceScenarioCursor(scenario, cursor, action = "next") {
  projectAgentScenario(scenario, cursor);
  if (cursor === scenario.events.length) return cursor;
  const required = nextScenarioAction(scenario, cursor);
  if (required && action !== required) return cursor;
  if (!required && action !== "next") return cursor;
  return cursor + 1;
}
