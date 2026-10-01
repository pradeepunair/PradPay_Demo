function freezeTable(table) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(table).map(([state, nextStates]) => [state, Object.freeze([...nextStates])]),
    ),
  );
}

export const transitionTables = Object.freeze({
  run: freezeTable({
    queued: ["running", "canceled", "expired"],
    running: ["awaiting_permission", "awaiting_payment", "blocked", "failed", "canceled", "expired"],
    awaiting_permission: ["running", "blocked", "canceled", "expired"],
    awaiting_authentication: ["awaiting_payment", "failed", "canceled", "expired"],
    awaiting_payment: ["awaiting_authentication", "succeeded", "blocked", "failed", "canceled"],
    succeeded: [], blocked: [], failed: [], canceled: [], expired: [],
  }),
  checkout: freezeTable({
    draft: ["quoted", "canceled", "expired"],
    quoted: ["ready", "draft", "canceled", "expired"],
    ready: ["completing", "draft", "canceled", "expired"],
    completing: ["completed", "canceled"],
    completed: [], canceled: [], expired: [],
  }),
  mandate: freezeTable({
    draft: ["active", "revoked", "expired"],
    active: ["reserved", "revoked", "expired"],
    reserved: ["consumed", "active", "revoked", "expired"],
    consumed: [], revoked: [], expired: [],
  }),
  attempt: freezeTable({
    prepared: ["submitted", "canceled"],
    submitted: ["requires_action", "processing", "succeeded", "failed", "canceled", "unknown"],
    requires_action: ["processing", "succeeded", "failed", "canceled", "unknown"],
    processing: ["succeeded", "failed", "canceled", "unknown"],
    unknown: ["processing", "succeeded", "failed", "canceled"],
    succeeded: [], failed: [], canceled: [],
  }),
  order: freezeTable({
    pending_payment: ["confirmed", "payment_failed", "canceled"],
    confirmed: [], payment_failed: [], canceled: [],
  }),
  webhook: freezeTable({
    received: ["verified", "rejected", "retry_pending"],
    verified: ["applied", "duplicate", "retry_pending"],
    retry_pending: ["verified", "applied", "duplicate", "rejected"],
    applied: ["duplicate"],
    duplicate: [], rejected: [],
  }),
});

export function canTransition(machine, from, to) {
  const table = transitionTables[machine];
  if (!table) throw new Error(`Unknown state machine: ${machine}`);
  if (!Object.hasOwn(table, from)) throw new Error(`Unknown ${machine} state: ${from}`);
  return table[from].includes(to);
}

export function transitionState(machine, from, to) {
  if (!canTransition(machine, from, to)) {
    throw new Error(`Illegal ${machine} transition: ${from} -> ${to}`);
  }
  return to;
}
