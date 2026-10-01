import type { AgentScenario } from "./agent-simulation-contracts.mjs";
export function nextScenarioAction(scenario: AgentScenario, cursor: number): string | null;
export function advanceScenarioCursor(scenario: AgentScenario, cursor: number, action?: string): number;
