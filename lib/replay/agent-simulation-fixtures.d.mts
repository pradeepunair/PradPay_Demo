import type { AgentFault, AgentScenario } from "./agent-simulation-contracts.mjs";
import type { StudioMission } from "./agent-simulation-commerce.mjs";
export function createAgentScenario(options?: { runId?: string; fault?: AgentFault;
  referenceTime?: string; stepMs?: number; mission?: StudioMission; selectedProductId?: string }): AgentScenario;
