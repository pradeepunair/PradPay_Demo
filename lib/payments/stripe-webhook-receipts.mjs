import { createHash } from "node:crypto";

import {
  classifyStripeEvent,
  verifyStripeEvent,
} from "../stripe-webhook.mjs";

export class WebhookRejectedError extends Error {
  constructor(code) {
    super(code);
    this.name = "WebhookRejectedError";
    this.code = code;
  }
}

function assertPersistence(persistence) {
  for (const method of ["withTransaction", "recordWebhookReceipt"]) {
    if (typeof persistence?.[method] !== "function") {
      throw new TypeError(`Webhook persistence requires ${method}().`);
    }
  }
}

function safeEvent(event) {
  return Object.freeze({
    provider: "stripe",
    providerEventId: event.id,
    type: event.type,
    providerCreatedAt: event.created,
    objectId: typeof event.data?.object?.id === "string" ? event.data.object.id : null,
  });
}

function minimalReceipt(event, rawBody, receivedAt) {
  return Object.freeze({
    provider: "stripe",
    providerEventId: event.id,
    type: event.type,
    livemode: false,
    providerCreatedAt: event.created,
    receivedAt: new Date(receivedAt).toISOString(),
    payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
  });
}

export function createStripeWebhookReceiptService({
  persistence,
  applyBusinessEvent,
  verifyEvent = verifyStripeEvent,
  now = Date.now,
  toleranceSeconds = 300,
}) {
  assertPersistence(persistence);
  if (typeof applyBusinessEvent !== "function") {
    throw new TypeError("Webhook receipt service requires applyBusinessEvent().");
  }

  return Object.freeze({
    async receive({ rawBody, signature, endpointSecret }) {
      if (!signature) throw new WebhookRejectedError("missing_signature");
      if (!endpointSecret) throw new WebhookRejectedError("missing_endpoint_secret");
      if (!(typeof rawBody === "string" || ArrayBuffer.isView(rawBody))) {
        throw new WebhookRejectedError("invalid_raw_body");
      }

      const receivedAt = now();
      let event;
      try {
        event = verifyEvent({
          rawBody,
          signature,
          endpointSecret,
          toleranceSeconds,
          receivedAt,
        });
      } catch {
        throw new WebhookRejectedError("invalid_signature");
      }

      const classification = classifyStripeEvent(event);
      if (!classification.accepted) {
        throw new WebhookRejectedError(classification.disposition);
      }
      if (typeof event.id !== "string" || typeof event.type !== "string") {
        throw new WebhookRejectedError("invalid_event_envelope");
      }

      const receipt = minimalReceipt(event, rawBody, receivedAt);
      return persistence.withTransaction(async (tx) => {
        const recorded = await persistence.recordWebhookReceipt(tx, receipt);
        if (recorded?.status === "duplicate") {
          return { disposition: "duplicate", receipt: recorded.receipt ?? receipt };
        }
        if (recorded?.status !== "created") {
          throw new Error("Webhook receipt persistence returned an invalid disposition.");
        }
        if (classification.disposition === "ignored") {
          return { disposition: "ignored", receipt };
        }
        const effect = await applyBusinessEvent(tx, safeEvent(event));
        return { disposition: effect?.disposition ?? "applied", receipt };
      });
    },
  });
}

const paymentStatusByType = Object.freeze({
  "payment_intent.processing": "processing",
  "payment_intent.requires_action": "requires_action",
  "payment_intent.succeeded": "succeeded",
  "payment_intent.payment_failed": "failed",
  "payment_intent.canceled": "canceled",
});
const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);

export function applyStripePaymentEvent({ current, event }) {
  const nextStatus = paymentStatusByType[event?.type];
  if (!nextStatus) return { disposition: "ignored_type", state: current };
  if (current?.providerEventId === event.providerEventId) {
    return { disposition: "duplicate", state: current };
  }
  if (current && event.providerCreatedAt < current.providerCreatedAt) {
    return { disposition: "ignored_stale", state: current };
  }
  if (current && event.providerCreatedAt === current.providerCreatedAt) {
    return { disposition: "ignored_ambiguous_order", state: current };
  }
  if (current && terminalStatuses.has(current.status) && nextStatus !== current.status) {
    return { disposition: "ignored_terminal", state: current };
  }
  return {
    disposition: "applied",
    state: Object.freeze({
      status: nextStatus,
      providerEventId: event.providerEventId,
      providerCreatedAt: event.providerCreatedAt,
    }),
  };
}
