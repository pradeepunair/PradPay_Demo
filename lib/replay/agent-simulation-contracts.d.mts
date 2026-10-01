export type AgentEventClass = "buyer_action" | "agent_request" | "seller_response" |
  "wallet_response" | "provider_request" | "provider_evidence" | "system";
export type AgentActor = "Buyer" | "Atlas" | "Wallet" | "Seller agent" |
  "Seller backend" | "Payment simulator" | "Simulation";
export type AgentFault = "none" | "merchant_refusal" | "buyer_decline" | "token_revoked" |
  "token_expired" | "changed_cart" | "lost_response" | "lost_response_recovered";
export type SafeSimulationPayload = Record<string, string | number | boolean>;
export interface AgentScenarioEvent {
  schemaVersion: "1.2.0";
  runId: string;
  eventId: string;
  sequence: number;
  occurredAt: string;
  eventClass: AgentEventClass;
  type: string;
  actor: AgentActor;
  recipient: AgentActor;
  requestId: string | null;
  responseTo: string | null;
  causeEventId: string | null;
  safePayload: SafeSimulationPayload;
  evidenceRefs: string[];
}
export interface AgentScenario {
  schemaVersion: "1.2.0";
  source: "local_simulation_fixture";
  runId: string;
  referenceTime: string;
  stepMs: number;
  fault: AgentFault;
  events: AgentScenarioEvent[];
}
export const SCENARIO_VERSION: "1.2.0";
export const REFERENCE_TIME: string;
export const STEP_MS: number;
export const FAULTS: readonly AgentFault[];
export const EVENT_DEFINITIONS: Readonly<Record<string, {
  eventClass: AgentEventClass; actor: AgentActor; recipient: AgentActor;
  payload: Record<string, (value: unknown) => boolean>;
}>>;
export function simulationTime(sequence: number, referenceTime?: string, stepMs?: number): string;
export function validateScenario(scenario: unknown): AgentScenario;
