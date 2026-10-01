export const KNOWN_EVENT_TYPES = new Set([
  "run.started", "mission.confirmed", "candidate.evaluated", "quote.created",
  "mandate.granted", "checkout.ready", "payment.submitted",
  "payment.provider_response_received", "webhook.verified", "order.confirmed",
]);

const nullableString = (value) => value === null || typeof value === "string";
const nullableInteger = (value) => value === null || Number.isSafeInteger(value);
const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

export const PROJECTION_FIELD_VALIDATORS = Object.freeze({
  shared: Object.freeze({ phase: nullableString, runStatus: nullableString, paymentStatus: nullableString, orderStatus: nullableString, totalMinor: nullableInteger, currency: nullableString }),
  buyer: Object.freeze({ mission: nullableString, requirements: stringArray, selectedProduct: nullableString, selectionReason: nullableString, authority: nullableString, quote: nullableString, receipt: nullableString }),
  merchant: Object.freeze({ request: nullableString, stock: nullableString, quote: nullableString, contributionMinor: nullableInteger, risk: nullableString }),
  psp: Object.freeze({ provider: nullableString, providerReference: nullableString, state: nullableString, webhook: nullableString, feeAssumptionMinor: nullableInteger }),
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const initialProjection = deepFreeze({
  shared: { phase: "Mission", runStatus: "queued", paymentStatus: "not_submitted", orderStatus: "pending_payment", totalMinor: null, currency: "USD" },
  buyer: { mission: null, requirements: [], selectedProduct: null, selectionReason: null, authority: "Not granted", quote: null, receipt: null },
  merchant: { request: null, stock: null, quote: null, contributionMinor: null, risk: "Not evaluated" },
  psp: { provider: "Stripe — sole enabled test provider", providerReference: null, state: "No submission", webhook: "Not received", feeAssumptionMinor: null },
});

function clone(value) { return structuredClone(value); }
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function validateProjectionPatch(patch) {
  if (!plainObject(patch)) throw new Error("Event patch must be a plain object");
  for (const [section, sectionPatch] of Object.entries(patch)) {
    const validators = PROJECTION_FIELD_VALIDATORS[section];
    if (!validators || !plainObject(sectionPatch)) throw new Error(`Unknown projection section: ${section}`);
    for (const [field, value] of Object.entries(sectionPatch)) {
      const validate = validators[field];
      if (!validate) throw new Error(`Unknown projection field: ${section}.${field}`);
      if (!validate(value)) throw new Error(`Invalid projection value: ${section}.${field}`);
    }
  }
  return patch;
}

function applyPatch(target, patch) {
  validateProjectionPatch(patch);
  for (const [section, sectionPatch] of Object.entries(patch)) {
    for (const [field, value] of Object.entries(sectionPatch)) target[section][field] = clone(value);
  }
}

export function projectEvents(events, cursorSequence) {
  const snapshot = clone(initialProjection);
  const visibleEvents = events.filter((event) => event.sequence <= cursorSequence);
  for (const event of visibleEvents) if (KNOWN_EVENT_TYPES.has(event.type)) applyPatch(snapshot, event.patch);
  return { ...snapshot, visibleEvents: clone(visibleEvents) };
}
