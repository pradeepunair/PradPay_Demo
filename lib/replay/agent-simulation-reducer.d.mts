import type { AgentScenario, AgentScenarioEvent } from "./agent-simulation-contracts.mjs";
export type WalletState = "disconnected" | "connected";
export type MissionState = "absent" | "established";
export type CheckoutState = "none" | "quote_requested" | "refused" | "quoted" | "blocked" | "completing" | "completed";
export type ApprovalState = "not_requested" | "pending" | "granted" | "declined";
export type TokenState = "none" | "requested" | "issued" | "presented" | "revoked";
export type AttemptState = "none" | "reserved" | "submitted" | "unknown" | "succeeded" | "failed";
export type OrderState = "none" | "pending_payment" | "payment_failed" | "confirmed";
export interface AgentScenarioState {
  session: "closed" | "open";
  wallet: WalletState;
  mission: MissionState;
  browsing: "not_authorized" | "authorized";
  discovery: "not_requested" | "requested" | "returned";
  checkout: CheckoutState;
  approval: ApprovalState;
  token: TokenState;
  attempt: AttemptState;
  order: OrderState;
  evidence: "none" | "verified";
  missionTerms: Record<string, string | number> | null;
  quote: Record<string, string | number> | null;
  approvalId: string | null;
  tokenReference: string | null;
  attemptId: string | null;
  orderId: string | null;
  evidenceReference: string | null;
  selectedProductId: string | null;
  reservationReference: string | null;
  reservation: "none" | "simulated";
  tokenScope: Record<string, string | number> | null;
  clockAt: string | null;
  checkoutDeniedReason: string | null;
}
export const initialScenarioState: Readonly<AgentScenarioState>;
export function projectAgentScenario(scenario: AgentScenario, cursor?: number): AgentScenarioState & {
  cursor: number; visibleEvents: AgentScenarioEvent[];
};
